# FFmpeg Utility Dockerfile
# Used for standalone FFmpeg operations

FROM debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wget \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app

USER appuser

ENTRYPOINT ["ffmpeg"]
CMD ["-version"]