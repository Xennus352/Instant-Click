"""Gemini-only text analysis and recap worker. No alternate/mock provider exists."""
import asyncio
import hmac
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import List, Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, ValidationError
from pydantic_settings import BaseSettings
from prometheus_client import Counter, Gauge, Histogram, generate_latest


class Settings(BaseSettings):
    gemini_api_key: Optional[str] = None
    gemini_model: str = "gemini-3.8-flash"
    worker_port: int = 8003
    request_timeout_seconds: float = 90
    log_level: str = "INFO"

    class Config:
        env_file = ".env"


settings = Settings()
logging.basicConfig(level=getattr(logging, settings.log_level), format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ai-worker")
REQUESTS = Counter("ai_requests_total", "AI requests", ["operation", "provider", "status"])
LATENCY = Histogram("ai_inference_duration_seconds", "Gemini inference duration", ["operation"])
QUEUE = Gauge("ai_queue_depth", "AI requests being processed")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")
GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta"
_provider_ready = False
_provider_error: Optional[str] = None
_provider_error_code: Optional[str] = None


def _gemini_failure(response: httpx.Response) -> tuple[str, str]:
    """Return sanitized readiness diagnostics; never return Google's raw error body."""
    try:
        error = response.json().get("error", {})
        provider_status = str(error.get("status", ""))
        provider_message = str(error.get("message", "")).lower()
    except (ValueError, AttributeError):
        provider_status, provider_message = "", ""
    if response.status_code == 400 and provider_status == "FAILED_PRECONDITION" and ("location" in provider_message or "region" in provider_message):
        return "GEMINI_LOCATION_UNSUPPORTED", "Gemini API is unavailable from this runtime location"
    if response.status_code in {401, 403}:
        return "GEMINI_CREDENTIALS_INVALID", "Gemini credentials are invalid or lack model access"
    return "GEMINI_MODEL_UNAVAILABLE", f"Gemini model readiness returned HTTP {response.status_code}"


class MovieAnalysisRequest(BaseModel):
    transcript: str = Field(min_length=1, max_length=500_000)
    language: str = Field(default="my", pattern="^(my|en|my\\+en)$")
    include_characters: bool = True
    include_key_scenes: bool = True


class Character(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=1000)
    screen_time: Optional[float] = Field(default=None, ge=0)
    importance: int = Field(default=1, ge=1, le=10)


class KeyScene(BaseModel):
    start_time: float = Field(ge=0)
    end_time: float = Field(ge=0)
    description: str = Field(min_length=1, max_length=1000)
    importance: int = Field(default=1, ge=1, le=10)


class MovieAnalysisResponse(BaseModel):
    genre: List[str]
    themes: List[str]
    characters: List[Character]
    plot_summary: str
    key_scenes: List[KeyScene]
    mood: str
    tone: str


class RecapGenerationRequest(BaseModel):
    transcript: str = Field(min_length=1, max_length=500_000)
    analysis: Optional[dict] = None
    style: str = Field(default="cinematic", min_length=1, max_length=80)
    target_length: int = Field(default=300, ge=15, le=3600)
    language: str = Field(default="my", pattern="^(my|en|my\\+en)$")


class ScriptSegment(BaseModel):
    order: int = Field(ge=0)
    text: str = Field(min_length=1, max_length=10000)
    start_time: Optional[float] = Field(default=None, ge=0)
    end_time: Optional[float] = Field(default=None, ge=0)
    voice_id: Optional[str] = Field(default=None, max_length=80)
    notes: Optional[str] = Field(default=None, max_length=500)


class RecapGenerationResponse(BaseModel):
    content: str = Field(min_length=1)
    segments: List[ScriptSegment]
    style: str
    target_length: int
    language: str


async def verify_internal_api_key(x_internal_api_key: Optional[str] = Header(None, alias="X-Internal-API-Key")):
    expected = os.getenv("INTERNAL_API_KEY", "")
    if len(expected) < 32:
        raise HTTPException(status_code=503, detail="Internal API key is not configured")
    if not x_internal_api_key or not hmac.compare_digest(x_internal_api_key, expected):
        raise HTTPException(status_code=401, detail="Invalid internal API key")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _provider_ready, _provider_error, _provider_error_code
    if not settings.gemini_api_key:
        _provider_error = "GEMINI_API_KEY is not configured"
        _provider_error_code = "GEMINI_KEY_MISSING"
    else:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(f"{GEMINI_API_ROOT}/models/{settings.gemini_model}",
                                             headers={"x-goog-api-key": settings.gemini_api_key})
            _provider_ready = response.status_code == 200
            _provider_error_code, _provider_error = (None, None) if _provider_ready else _gemini_failure(response)
        except httpx.HTTPError as exc:
            _provider_error = f"Gemini readiness request failed ({type(exc).__name__})"
            _provider_error_code = "GEMINI_NETWORK_UNAVAILABLE"
    if not _provider_ready:
        logger.warning("Gemini worker not ready: %s", _provider_error)
    yield


app = FastAPI(title="InstantCap Gemini Text Worker", version="0.2.0", lifespan=lifespan)


def _schema(model: type[BaseModel]) -> dict:
    # Gemini supports JSON Schema output via responseJsonSchema.
    return model.model_json_schema()


async def _generate(prompt: str, response_model: type[BaseModel]) -> BaseModel:
    if not settings.gemini_api_key:
        raise HTTPException(status_code=503, detail="Gemini is not configured")
    url = f"{GEMINI_API_ROOT}/models/{settings.gemini_model}:generateContent"
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": _schema(response_model)},
    }
    try:
        async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
            response = await client.post(url, headers={"x-goog-api-key": settings.gemini_api_key}, json=body)
        if response.status_code in {401, 403}:
            raise HTTPException(status_code=503, detail="Gemini credentials are invalid or lack model access")
        if response.status_code == 400:
            error_code, safe_message = _gemini_failure(response)
            if error_code == "GEMINI_LOCATION_UNSUPPORTED":
                raise HTTPException(status_code=503, detail=safe_message)
        if response.status_code == 429 or response.status_code >= 500:
            raise HTTPException(status_code=503, detail="Gemini is temporarily unavailable")
        if response.status_code != 200:
            logger.error("Gemini rejected request: HTTP %s", response.status_code)
            raise HTTPException(status_code=502, detail="Gemini rejected the generation request")
        payload = response.json()
        parts = payload["candidates"][0]["content"]["parts"]
        text = "".join(part.get("text", "") for part in parts)
        value = json.loads(text)
        parsed = response_model.model_validate(value)
        # Transcript-only input has no video timestamps; never persist generated scene times.
        if isinstance(parsed, MovieAnalysisResponse):
            parsed.key_scenes = []
            for character in parsed.characters:
                character.screen_time = None
        return parsed
    except HTTPException:
        raise
    except (KeyError, IndexError, TypeError, ValueError, ValidationError) as exc:
        logger.warning("Gemini returned invalid structured output (%s)", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Gemini returned invalid structured output") from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=503, detail="Gemini request timed out") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Gemini request failed") from exc


def _analysis_prompt(request: MovieAnalysisRequest) -> str:
    return ("Analyze the provided speech transcript only; no video frames or visual evidence are available. "
            "Do not invent visual details, timestamps, or scene boundaries. If the transcript does not provide timing, "
            "return an empty key_scenes array. Return the requested JSON object in language " + request.language + ".\n\n" +
            "TRANSCRIPT:\n" + request.transcript)


def _recap_prompt(request: RecapGenerationRequest) -> str:
    return (f"Write a {request.style} recap based only on this transcript in {request.language}. "
            f"Target narration duration is {request.target_length} seconds. Do not add events absent from the transcript. "
            "Use null for segment start_time/end_time because source timestamps are not supplied. "
            "Return the requested JSON object.\n\nTRANSCRIPT:\n" + request.transcript +
            "\n\nANALYSIS:\n" + json.dumps(request.analysis, ensure_ascii=False) if request.analysis else
            f"Write a {request.style} recap based only on this transcript in {request.language}. "
            f"Target narration duration is {request.target_length} seconds. Do not add events absent from the transcript. "
            "Use null for segment start_time/end_time because source timestamps are not supplied. "
            "Return the requested JSON object.\n\nTRANSCRIPT:\n" + request.transcript)


@app.get("/health")
async def health():
    return {"status": "healthy" if _provider_ready else "degraded", "gemini_configured": bool(settings.gemini_api_key),
            "default_provider": "gemini", "gemini_model": settings.gemini_model}


@app.get("/ready")
async def ready():
    # Recheck on demand so a key added after startup can make the service ready.
    global _provider_ready, _provider_error, _provider_error_code
    if settings.gemini_api_key:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(f"{GEMINI_API_ROOT}/models/{settings.gemini_model}",
                                             headers={"x-goog-api-key": settings.gemini_api_key})
            _provider_ready = response.status_code == 200
            _provider_error_code, _provider_error = (None, None) if _provider_ready else _gemini_failure(response)
        except httpx.HTTPError as exc:
            _provider_ready = False
            _provider_error = f"Gemini readiness request failed ({type(exc).__name__})"
            _provider_error_code = "GEMINI_NETWORK_UNAVAILABLE"
    else:
        _provider_ready = False
        _provider_error = "GEMINI_API_KEY is not configured"
        _provider_error_code = "GEMINI_KEY_MISSING"
    data = {"ready": _provider_ready, "gemini_configured": bool(settings.gemini_api_key), "default_provider": "gemini",
            "provider_available": _provider_ready, "gemini_model": settings.gemini_model,
            "provider_error_code": _provider_error_code, "provider_error": _provider_error}
    return Response(content=json.dumps(data), media_type="application/json", status_code=200 if _provider_ready else 503)


@app.post("/analyze", response_model=MovieAnalysisResponse)
async def analyze_movie(request: MovieAnalysisRequest, _=Depends(verify_internal_api_key)):
    QUEUE.inc(); REQUESTS.labels(operation="analyze", provider="gemini", status="started").inc()
    try:
        with LATENCY.labels(operation="analyze").time():
            result = await _generate(_analysis_prompt(request), MovieAnalysisResponse)
        REQUESTS.labels(operation="analyze", provider="gemini", status="completed").inc()
        return result
    except HTTPException:
        REQUESTS.labels(operation="analyze", provider="gemini", status="failed").inc()
        raise
    finally:
        QUEUE.dec()


@app.post("/recap", response_model=RecapGenerationResponse)
async def generate_recap(request: RecapGenerationRequest, _=Depends(verify_internal_api_key)):
    QUEUE.inc(); REQUESTS.labels(operation="recap", provider="gemini", status="started").inc()
    try:
        with LATENCY.labels(operation="recap").time():
            result = await _generate(_recap_prompt(request), RecapGenerationResponse)
        REQUESTS.labels(operation="recap", provider="gemini", status="completed").inc()
        return result
    except HTTPException:
        REQUESTS.labels(operation="recap", provider="gemini", status="failed").inc()
        raise
    finally:
        QUEUE.dec()


@app.get("/metrics")
async def metrics():
    return Response(generate_latest(), media_type="text/plain")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.worker_port)
