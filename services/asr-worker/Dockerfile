# ASR Worker Production Dockerfile
# Nara SAR inference service with ONNX Runtime

FROM python:3.11-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app

# ============================================================
# BUILDER: Install dependencies
# ============================================================
FROM base AS builder

COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# ============================================================
# RUNNER: Copy deps and app
# ============================================================
FROM base AS runner

COPY --from=builder /root/.local /home/appuser/.local
ENV PATH=/home/appuser/.local/bin:$PATH

# Copy application code
COPY --chown=appuser:appuser app.py .

USER appuser

EXPOSE 8001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:8001/health || exit 1

ENTRYPOINT ["dumb-init", "--"]

CMD ["python", "app.py"]