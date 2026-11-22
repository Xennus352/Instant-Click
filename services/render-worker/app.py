"""
Render Worker - FFmpeg Video Rendering
InstantCap Milestone 5+ Implementation
"""

import os
import subprocess
import tempfile
import logging
import shutil
from contextlib import asynccontextmanager
from typing import Optional, List
from pathlib import Path

import boto3
from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends, Header, status
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
from prometheus_client import Counter, Histogram, Gauge, generate_latest
from fastapi.responses import Response

# ============================================================
# CONFIGURATION
# ============================================================
class Settings(BaseSettings):
    s3_endpoint: str = "http://minio:9000"
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_bucket: str = "instantcap"
    s3_region: str = "us-east-1"
    ffmpeg_threads: int = 4
    worker_port: int = 8004
    log_level: str = "INFO"

    class Config:
        env_file = ".env"


settings = Settings()

# ============================================================
# LOGGING
# ============================================================
logging.basicConfig(
    level=getattr(logging, settings.log_level),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("render-worker")

# ============================================================
# METRICS
# ============================================================
RENDER_REQUESTS = Counter("render_requests_total", "Total render requests", ["status"])
RENDER_LATENCY = Histogram("render_duration_seconds", "Render duration")
RENDER_PROGRESS = Gauge("render_progress_percent", "Current render progress")
RENDER_QUEUE_DEPTH = Gauge("render_queue_depth", "Current queue depth")
FFMPEG_AVAILABLE = Gauge("ffmpeg_available", "FFmpeg availability")

# ============================================================
# S3 CLIENT
# ============================================================
s3_client = boto3.client(
    "s3",
    endpoint_url=settings.s3_endpoint,
    aws_access_key_id=settings.s3_access_key,
    aws_secret_access_key=settings.s3_secret_key,
    region_name=settings.s3_region,
)


# ============================================================
# LIFESPAN
# ============================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Check FFmpeg
    try:
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        if result.returncode == 0:
            FFMPEG_AVAILABLE.set(1)
            logger.info("FFmpeg available")
        else:
            FFMPEG_AVAILABLE.set(0)
            logger.error("FFmpeg not working")
    except FileNotFoundError:
        FFMPEG_AVAILABLE.set(0)
        logger.error("FFmpeg not installed")

    yield
    logger.info("Shutting down render worker")


# ============================================================
# INTERNAL API KEY VALIDATION
# ============================================================
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY")


async def verify_internal_api_key(
    x_internal_api_key: Optional[str] = Header(None, alias="X-Internal-API-Key"),
) -> None:
    """Verify the internal API key for worker-to-worker requests."""
    expected_key = INTERNAL_API_KEY

    if not expected_key:
        # No key configured - deny access in production, allow in dev
        if os.getenv("NODE_ENV") != "development":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Internal API key not configured on server",
            )
        return  # Allow in development without key

    if not x_internal_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-Internal-API-Key header",
        )

    if x_internal_api_key != expected_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid internal API key",
        )


# ============================================================
# APP
# ============================================================
app = FastAPI(
    title="InstantCap Render Worker",
    description="FFmpeg Video Rendering Service",
    version="0.1.0",
    lifespan=lifespan,
)


# ============================================================
# MODELS
# ============================================================
class RenderRequest(BaseModel):
    project_id: str
    video_key: str  # S3 key for source video
    audio_key: Optional[str] = None  # S3 key for narration audio
    subtitle_key: Optional[str] = None  # S3 key for subtitle file
    output_key: str  # S3 key for output
    resolution: str = Field(default="1080p", pattern="^(720p|1080p|4k)$")
    fps: int = Field(default=30, ge=1, le=60)
    codec: str = Field(default="libx264", pattern="^(libx264|libx265|libvpx-vp9)$")
    bitrate: Optional[str] = None
    preset: str = Field(default="medium", pattern="^(ultrafast|superfast|veryfast|faster|fast|medium|slow|slower|veryslow)$")


class RenderResponse(BaseModel):
    project_id: str
    output_key: str
    status: str
    duration: Optional[float] = None
    file_size: Optional[int] = None
    ffmpeg_command: str


class HealthResponse(BaseModel):
    status: str
    ffmpeg_available: bool
    ffmpeg_version: str


class ReadyResponse(BaseModel):
    ready: bool
    ffmpeg_available: bool
    ffmpeg_version: str
    ffprobe_available: bool


class AudioExtractionRequest(BaseModel):
    project_id: str
    job_id: str
    bucket: str
    source_key: str
    # output_key will be deterministic: {project_id}/audio/extracted.wav


class AudioExtractionResponse(BaseModel):
    project_id: str
    job_id: str
    audio_key: str
    duration: float
    file_size: int
    format: str = "wav"
    sample_rate: int = 16000
    channels: int = 1


# ============================================================
# HELPERS
# ============================================================
def get_ffmpeg_version() -> str:
    try:
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        return result.stdout.split("\n")[0]
    except:
        return "unknown"


def download_from_s3(key: str, local_path: str) -> None:
    """Download file from S3/MinIO."""
    s3_client.download_file(settings.s3_bucket, key, local_path)


def upload_to_s3(local_path: str, key: str) -> None:
    """Upload file to S3/MinIO."""
    s3_client.upload_file(local_path, settings.s3_bucket, key)


def get_video_duration(file_path: str) -> float:
    """Get video duration using ffprobe."""
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", file_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return float(result.stdout.strip())


def build_render_command(request: RenderRequest, input_paths: dict, output_path: str) -> List[str]:
    """Build FFmpeg command for rendering."""
    cmd = [
        "ffmpeg", "-y",
        "-threads", str(settings.ffmpeg_threads),
    ]

    # Input video
    cmd.extend(["-i", input_paths["video"]])

    # Input audio (narration)
    if "audio" in input_paths:
        cmd.extend(["-i", input_paths["audio"]])

    # Input subtitle
    if "subtitle" in input_paths:
        cmd.extend(["-i", input_paths["subtitle"]])

    # Video encoding
    cmd.extend([
        "-c:v", request.codec,
        "-preset", request.preset,
        "-r", str(request.fps),
    ])

    # Apply scaling and burned-in subtitles in one filter chain. Passing two
    # -vf arguments causes FFmpeg to discard the earlier filter.
    video_filters = []
    if request.resolution == "720p":
        video_filters.append("scale=-2:720")
    elif request.resolution == "1080p":
        video_filters.append("scale=-2:1080")
    elif request.resolution == "4k":
        video_filters.append("scale=-2:2160")

    # Bitrate
    if request.bitrate:
        cmd.extend(["-b:v", request.bitrate])

    # Audio encoding
    if "audio" in input_paths:
        cmd.extend(["-c:a", "aac", "-b:a", "128k", "-map", "1:a"])
    else:
        cmd.extend(["-c:a", "copy"])

    # Subtitles
    if "subtitle" in input_paths:
        # The path is generated by tempfile.TemporaryDirectory and does not
        # include user-controlled input; avoid shell execution entirely.
        video_filters.append(f"subtitles={input_paths['subtitle']}")
    if video_filters:
        cmd.extend(["-vf", ",".join(video_filters)])

    # Output
    cmd.extend(["-movflags", "+faststart", output_path])

    return cmd


# ============================================================
# ROUTES
# ============================================================
@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="healthy" if FFMPEG_AVAILABLE._value.get() else "degraded",
        ffmpeg_available=bool(FFMPEG_AVAILABLE._value.get()),
        ffmpeg_version=get_ffmpeg_version(),
    )


@app.get("/ready", response_model=ReadyResponse)
async def ready():
    """Readiness check - verifies FFmpeg and ffprobe are available."""
    try:
        ffmpeg_result = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        ffmpeg_ok = ffmpeg_result.returncode == 0
        ffmpeg_version = ffmpeg_result.stdout.split("\n")[0] if ffmpeg_ok else "unknown"
    except FileNotFoundError:
        ffmpeg_ok = False
        ffmpeg_version = "unknown"

    try:
        ffprobe_result = subprocess.run(["ffprobe", "-version"], capture_output=True, text=True)
        ffprobe_ok = ffprobe_result.returncode == 0
    except FileNotFoundError:
        ffprobe_ok = False

    return ReadyResponse(
        ready=ffmpeg_ok and ffprobe_ok,
        ffmpeg_available=ffmpeg_ok,
        ffmpeg_version=ffmpeg_version,
        ffprobe_available=ffprobe_ok,
    )


@app.post("/render", response_model=RenderResponse)
async def render_video(request: RenderRequest, background_tasks: BackgroundTasks, _: None = Depends(verify_internal_api_key)):
    RENDER_QUEUE_DEPTH.inc()
    RENDER_REQUESTS.labels(status="started").inc()

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir = Path(tmpdir)
            input_paths = {}

            # Download video
            video_path = tmpdir / "input_video.mp4"
            download_from_s3(request.video_key, str(video_path))
            input_paths["video"] = str(video_path)

            # Download audio if provided
            if request.audio_key:
                audio_path = tmpdir / "narration.wav"
                download_from_s3(request.audio_key, str(audio_path))
                input_paths["audio"] = str(audio_path)

            # Download subtitle if provided
            if request.subtitle_key:
                subtitle_path = tmpdir / "subtitle.srt"
                download_from_s3(request.subtitle_key, str(subtitle_path))
                input_paths["subtitle"] = str(subtitle_path)

            # Output path
            output_path = tmpdir / "output.mp4"

            # Build and execute FFmpeg command
            cmd = build_render_command(request, input_paths, str(output_path))
            logger.info(f"Executing: {' '.join(cmd)}")

            RENDER_PROGRESS.set(0)

            # Run with progress monitoring
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            # Monitor progress (simplified)
            while True:
                output = process.stderr.readline()
                if output == "" and process.poll() is not None:
                    break
                if "time=" in output:
                    # Parse progress (simplified)
                    pass

            returncode = process.wait()

            if returncode != 0:
                stderr = process.stderr.read()
                raise RuntimeError(f"FFmpeg failed: {stderr}")

            RENDER_PROGRESS.set(100)

            # Get output info
            duration = get_video_duration(str(output_path))
            file_size = output_path.stat().st_size

            # Upload to S3
            upload_to_s3(str(output_path), request.output_key)

            RENDER_REQUESTS.labels(status="completed").inc()

            return RenderResponse(
                project_id=request.project_id,
                output_key=request.output_key,
                status="completed",
                duration=duration,
                file_size=file_size,
                ffmpeg_command=" ".join(cmd),
            )

    except Exception as e:
        logger.error(f"Render failed: {e}")
        RENDER_REQUESTS.labels(status="failed").inc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        RENDER_QUEUE_DEPTH.dec()


def extract_audio_from_video(video_path: str, output_path: str) -> float:
    """Extract audio from video using FFmpeg. Returns duration in seconds."""
    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-vn",  # No video
        "-acodec", "pcm_s16le",  # PCM 16-bit little-endian
        "-ar", "16000",  # 16kHz sample rate
        "-ac", "1",  # Mono
        output_path,
    ]
    logger.info(f"Executing audio extraction: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg audio extraction failed: {result.stderr}")
    # Get duration
    return get_video_duration(output_path)


@app.post("/extract-audio", response_model=AudioExtractionResponse)
async def extract_audio(request: AudioExtractionRequest, _: None = Depends(verify_internal_api_key)):
    """Extract audio from video file in S3/MinIO."""
    RENDER_QUEUE_DEPTH.inc()
    RENDER_REQUESTS.labels(status="started").inc()

    # Deterministic output key
    output_key = f"{request.project_id}/audio/extracted.wav"

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir = Path(tmpdir)

            # Download video
            video_path = tmpdir / "input_video.mp4"
            download_from_s3(request.source_key, str(video_path))

            # Extract audio
            audio_path = tmpdir / "extracted.wav"
            duration = extract_audio_from_video(str(video_path), str(audio_path))

            # Get file size
            audio_path_obj = Path(audio_path)
            file_size = audio_path_obj.stat().st_size

            # Upload to S3/MinIO (deterministic key)
            upload_to_s3(str(audio_path), output_key)

            RENDER_REQUESTS.labels(status="completed").inc()

            return AudioExtractionResponse(
                project_id=request.project_id,
                job_id=request.job_id,
                audio_key=output_key,
                duration=duration,
                file_size=audio_path_obj.stat().st_size,
            )

    except Exception as e:
        logger.error(f"Audio extraction failed: {e}")
        RENDER_REQUESTS.labels(status="failed").inc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        RENDER_QUEUE_DEPTH.dec()


@app.get("/metrics")
async def metrics():
    return Response(content=generate_latest(), media_type="text/plain")


# ============================================================
# MAIN
# ============================================================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.worker_port)
