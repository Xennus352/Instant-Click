"""Nara SAR ASR worker. Uses the model owner's released inference runner."""
import asyncio
import hmac
import importlib.util
import logging
import os
import sys
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel
from pydantic_settings import BaseSettings
from prometheus_client import Counter, Gauge, Histogram, generate_latest


class Settings(BaseSettings):
    model_path: str = "/models/nara-sar/onnx/acoustic.onnx"
    max_audio_bytes: int = 268435456
    ort_threads: int = 2
    worker_port: int = 8001
    log_level: str = "INFO"

    class Config:
        env_file = ".env"


settings = Settings()
logging.basicConfig(level=getattr(logging, settings.log_level), format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("asr-worker")
REQUESTS = Counter("asr_requests_total", "ASR requests", ["status"])
LATENCY = Histogram("asr_inference_duration_seconds", "ASR inference duration")
QUEUE = Gauge("asr_queue_depth", "ASR requests being processed")
MODEL_LOADED = Gauge("asr_model_loaded", "Nara SAR readiness")
_model_dir = Path(settings.model_path).resolve().parent.parent
_runner = None
_model_error: Optional[str] = None


def _load_runner():
    global _runner, _model_error
    required = ("onnx/acoustic.onnx", "sar.json", "language.lm", "tokenizer.model", "sar_decoder.py", "transcribe.py")
    missing = [name for name in required if not (_model_dir / name).is_file()]
    if missing:
        _model_error = "model files missing: " + ", ".join(missing)
        MODEL_LOADED.set(0)
        return
    spec = importlib.util.spec_from_file_location("nara_sar_transcribe", _model_dir / "transcribe.py")
    if not spec or not spec.loader:
        _model_error = "official Nara SAR runner could not be loaded"
        MODEL_LOADED.set(0)
        return
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(_model_dir))
    spec.loader.exec_module(module)
    _runner = module
    _model_error = None
    MODEL_LOADED.set(1)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        _load_runner()
    except Exception as exc:
        logger.error("Nara SAR runner initialization failed: %s", type(exc).__name__)
        MODEL_LOADED.set(0)
    yield


app = FastAPI(title="InstantCap Nara SAR ASR", version="0.2.0", lifespan=lifespan)


class TranscribeResponse(BaseModel):
    text: str
    # This echoes the caller's requested label; Nara SAR does not detect a language label.
    language: str
    duration: float
    segments: list = []


async def verify_internal_api_key(x_internal_api_key: Optional[str] = Header(None, alias="X-Internal-API-Key")):
    expected = os.getenv("INTERNAL_API_KEY", "")
    if len(expected) < 32:
        raise HTTPException(status_code=503, detail="Internal API key is not configured")
    if not x_internal_api_key or not hmac.compare_digest(x_internal_api_key, expected):
        raise HTTPException(status_code=401, detail="Invalid internal API key")


@app.get("/health")
async def health():
    return {"status": "healthy" if _runner else "degraded", "model_loaded": bool(_runner)}


@app.get("/ready")
async def ready():
    checks = {name: (_model_dir / name).is_file() for name in (
        "onnx/acoustic.onnx", "sar.json", "language.lm", "tokenizer.model", "sar_decoder.py", "transcribe.py")}
    ready_now = bool(_runner) and all(checks.values())
    return Response(
        content=__import__("json").dumps({"ready": ready_now, "model_loaded": bool(_runner), "model_files_present": checks,
                                           "missing_files": [k for k, v in checks.items() if not v],
                                           "error": _model_error}),
        media_type="application/json", status_code=200 if ready_now else 503)


async def _run_inference(path: str, language: str):
    if not _runner:
        raise HTTPException(status_code=503, detail="Nara SAR is not ready")
    try:
        with LATENCY.time():
            result = await asyncio.to_thread(_runner.transcribe, Path(path), _model_dir, "onnx", "int8", settings.ort_threads)
        return TranscribeResponse(text=result["text"], language=language, duration=result["audio_seconds"], segments=[])
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=f"Nara SAR rejected audio: {str(exc)[:200]}") from exc
    except Exception as exc:
        logger.error("Nara SAR inference failed: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Nara SAR inference failed") from exc


@app.post("/transcribe/file", response_model=TranscribeResponse)
async def transcribe_file(file: UploadFile = File(...), language: str = Form("my"),
                         return_timestamps: bool = Form(False), _=Depends(verify_internal_api_key)):
    if language not in {"my", "en", "my+en"}:
        raise HTTPException(status_code=422, detail="language must be my, en, or my+en")
    if return_timestamps:
        raise HTTPException(status_code=422, detail="Nara SAR runner does not provide timestamps")
    suffix = Path(file.filename or "audio.wav").suffix[:10] or ".wav"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    total = 0
    QUEUE.inc()
    try:
        with os.fdopen(fd, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > settings.max_audio_bytes:
                    raise HTTPException(status_code=413, detail="Audio exceeds configured byte limit")
                out.write(chunk)
        if not total:
            raise HTTPException(status_code=422, detail="Audio file is empty")
        result = await _run_inference(tmp_path, language)
        REQUESTS.labels(status="completed").inc()
        return result
    except HTTPException:
        REQUESTS.labels(status="failed").inc()
        raise
    finally:
        QUEUE.dec()
        await file.close()
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass


@app.get("/metrics")
async def metrics():
    return Response(generate_latest(), media_type="text/plain")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.worker_port)
