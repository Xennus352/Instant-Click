# SPDX-License-Identifier: Apache-2.0
# Adapted from YeeNyunn/nara-mini-v1/synthesize.py; Copyright Nara contributors.
"""Nara Mini v1 TTS worker using the released frontend and ONNX voice graphs."""
import asyncio
import base64
import hmac
import io
import json
import logging
import os
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import onnxruntime as ort
import soundfile as sf
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
from prometheus_client import Counter, Gauge, Histogram, generate_latest


class Settings(BaseSettings):
    model_dir: str = "/models/nara-mini-v1"
    voices: str = "shoon,thazin,ko-banyar,htet-myat"
    ort_threads: int = 4
    worker_port: int = 8002
    log_level: str = "INFO"

    class Config:
        env_file = ".env"


settings = Settings()
AVAILABLE_VOICES = [voice.strip() for voice in settings.voices.split(",") if voice.strip()]
logging.basicConfig(level=getattr(logging, settings.log_level), format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("tts-worker")
REQUESTS = Counter("tts_requests_total", "TTS requests", ["voice", "status"])
LATENCY = Histogram("tts_inference_duration_seconds", "TTS inference duration", ["voice"])
QUEUE = Gauge("tts_queue_depth", "TTS requests being processed")
VOICE_LOADED = Gauge("tts_voice_loaded", "Nara Mini voice readiness", ["voice"])


class VoiceModel:
    def __init__(self, voice_id: str):
        self.voice_id = voice_id
        self.folder = Path(settings.model_dir).resolve() / "onnx" / voice_id
        self.encoder: Optional[ort.InferenceSession] = None
        self.decoder: Optional[ort.InferenceSession] = None
        self.metadata: dict = {}

    def load(self):
        required = [self.folder / name for name in ("encoder.onnx", "decoder.onnx", "voice.json")]
        if not all(path.is_file() for path in required):
            raise FileNotFoundError(f"Model files missing for voice {self.voice_id}")
        options = ort.SessionOptions()
        options.intra_op_num_threads = settings.ort_threads
        options.inter_op_num_threads = 1
        self.encoder = ort.InferenceSession(str(required[0]), options, providers=["CPUExecutionProvider"])
        self.decoder = ort.InferenceSession(str(required[1]), options, providers=["CPUExecutionProvider"])
        self.metadata = json.loads(required[2].read_text(encoding="utf-8"))


voice_models: Dict[str, VoiceModel] = {}
_frontend = None
_missing_frontend: list[str] = []


def load_models():
    global _frontend
    root = Path(settings.model_dir).resolve()
    required = [root / path for path in ("synthesize.py", "frontend/english.py", "frontend/my_numbers.py", "frontend/nara_frontend.py")]
    _missing_frontend = [str(path.relative_to(root)) for path in required if not path.is_file()]
    if _missing_frontend:
        raise FileNotFoundError("Nara Mini frontend files are missing")
    sys.path.insert(0, str(root))
    from frontend.english import to_tokens
    from frontend.my_numbers import verbalize
    from frontend.nara_frontend import phonemize, prepare_names
    _frontend = {"to_tokens": to_tokens, "verbalize": verbalize, "phonemize": phonemize, "prepare_names": prepare_names}
    for voice in AVAILABLE_VOICES:
        try:
            model = VoiceModel(voice)
            model.load()
            voice_models[voice] = model
            VOICE_LOADED.labels(voice=voice).set(1)
        except Exception as exc:
            logger.error("Nara Mini voice %s failed to load: %s", voice, type(exc).__name__)
            VOICE_LOADED.labels(voice=voice).set(0)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        load_models()
    except Exception as exc:
        logger.error("Nara Mini initialization failed: %s", type(exc).__name__)
    yield


app = FastAPI(title="InstantCap Nara Mini TTS", version="0.2.0", lifespan=lifespan)


async def verify_internal_api_key(x_internal_api_key: Optional[str] = Header(None, alias="X-Internal-API-Key")):
    expected = os.getenv("INTERNAL_API_KEY", "")
    if len(expected) < 32:
        raise HTTPException(status_code=503, detail="Internal API key is not configured")
    if not x_internal_api_key or not hmac.compare_digest(x_internal_api_key, expected):
        raise HTTPException(status_code=401, detail="Invalid internal API key")


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    voice: str = "shoon"
    language: str = "my"
    normalize_numbers: bool = True


class SynthesizeResponse(BaseModel):
    audio_base64: str
    voice: str
    duration: float
    sample_rate: int = 24000


def _split_speech(text: str, limit: int = 200) -> list[str]:
    units = []
    for sentence in re.split(r"(?<=[။!?…\n])\s*", text):
        for clause in re.split(r"(?<=၊)\s*", sentence):
            while len(clause) > limit:
                cut = clause.rfind(" ", 0, limit)
                if cut <= 0:
                    cut = limit
                units.append(clause[:cut])
                clause = clause[cut:].strip()
            if clause.strip():
                units.append(clause.strip())
    pieces, current = [], ""
    for unit in units:
        if current and len(current) + 1 + len(unit) > limit:
            pieces.append(current)
            current = unit
        else:
            current = f"{current} {unit}".strip()
    if current:
        pieces.append(current)
    return pieces


def _synthesize(text: str, model: VoiceModel, normalize_numbers: bool) -> np.ndarray:
    if not _frontend or not model.encoder or not model.decoder:
        raise RuntimeError("Nara Mini is not ready")
    if normalize_numbers:
        text = _frontend["verbalize"](text)
    samples = []
    for piece in _split_speech(text):
        chars = _frontend["phonemize"](_frontend["to_tokens"](_frontend["prepare_names"](piece)))
        tokens = [model.metadata["vocab"][char] for char in chars if char in model.metadata["vocab"]]
        if not tokens:
            raise ValueError("A passage produced no phonemes")
        if len(tokens) > 508:
            raise ValueError("A passage exceeds the Nara Mini phoneme context limit")
        index = int(np.argmin(np.abs(np.asarray(model.metadata["centers"]) - len(tokens))))
        style = np.asarray([model.metadata["styles"][index]], dtype=np.float32)
        durations, prosody, encoded_text = model.encoder.run(
            ["durations", "prosody", "text"],
            {"tokens": np.asarray([[0, *tokens, 0]], dtype=np.int64), "style": style})
        if durations.min() < 1 or not 1 <= durations.sum() <= 20000:
            raise ValueError("Nara Mini returned an invalid duration")
        audio = model.decoder.run(None, {
            "prosody": np.repeat(prosody, durations[0], axis=2),
            "text": np.repeat(encoded_text, durations[0], axis=2),
            "style": style,
        })[0].reshape(-1)
        if audio.size < 2400 or not np.isfinite(audio).all():
            raise ValueError("Nara Mini returned invalid audio")
        if samples:
            samples.append(np.zeros(4800, dtype=np.float32))
        samples.append(audio)
    return np.clip(np.concatenate(samples), -1, 1)


@app.get("/health")
async def health():
    loaded = [voice for voice in AVAILABLE_VOICES if voice in voice_models]
    return {"status": "healthy" if loaded else "degraded", "models_loaded": len(loaded), "available_voices": loaded}


@app.get("/ready")
async def ready():
    root = Path(settings.model_dir).resolve()
    frontend_files = ["synthesize.py", "frontend/english.py", "frontend/my_numbers.py", "frontend/nara_frontend.py"]
    voice_details = {voice: {"loaded": voice in voice_models,
                             "encoder_loaded": bool(voice_models.get(voice) and voice_models[voice].encoder),
                             "decoder_loaded": bool(voice_models.get(voice) and voice_models[voice].decoder)}
                     for voice in AVAILABLE_VOICES}
    files_present = {name: (root / name).is_file() for name in frontend_files}
    is_ready = bool(AVAILABLE_VOICES) and all(v["loaded"] for v in voice_details.values()) and all(files_present.values()) and _frontend is not None
    return Response(content=json.dumps({"ready": is_ready, "models_loaded": len(voice_models),
                                        "available_voices": list(voice_models), "voices_detail": voice_details,
                                        "frontend_files_present": files_present}),
                    media_type="application/json", status_code=200 if is_ready else 503)


@app.get("/voices")
async def list_voices():
    return {"voices": [{"id": voice, "name": voice.capitalize(), "language": "my+en",
                        "loaded": voice in voice_models, "sample_rate": 24000} for voice in AVAILABLE_VOICES]}


@app.post("/synthesize", response_model=SynthesizeResponse)
async def synthesize(request: SynthesizeRequest, _=Depends(verify_internal_api_key)):
    if request.voice not in AVAILABLE_VOICES:
        raise HTTPException(status_code=422, detail="Unsupported Nara Mini voice")
    if request.language not in {"my", "en", "my+en"}:
        raise HTTPException(status_code=422, detail="language must be my, en, or my+en")
    model = voice_models.get(request.voice)
    if model is None:
        raise HTTPException(status_code=503, detail="Requested Nara Mini voice is not ready")
    QUEUE.inc()
    REQUESTS.labels(voice=request.voice, status="started").inc()
    try:
        with LATENCY.labels(voice=request.voice).time():
            audio = await asyncio.to_thread(_synthesize, request.text, model, request.normalize_numbers)
        buffer = io.BytesIO()
        sf.write(buffer, audio, 24000, format="WAV", subtype="PCM_16")
        return SynthesizeResponse(audio_base64=base64.b64encode(buffer.getvalue()).decode("ascii"),
                                  voice=request.voice, duration=len(audio) / 24000)
    except (ValueError, RuntimeError) as exc:
        REQUESTS.labels(voice=request.voice, status="failed").inc()
        raise HTTPException(status_code=422, detail=str(exc)[:250]) from exc
    except Exception as exc:
        logger.error("Nara Mini inference failed: %s", type(exc).__name__)
        REQUESTS.labels(voice=request.voice, status="failed").inc()
        raise HTTPException(status_code=503, detail="Nara Mini inference failed") from exc
    finally:
        QUEUE.dec()


@app.get("/metrics")
async def metrics():
    return Response(generate_latest(), media_type="text/plain")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.worker_port)
