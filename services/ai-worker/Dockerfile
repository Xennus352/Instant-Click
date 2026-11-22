# AI Worker Production Dockerfile
# Gemini/Groq API integration for movie understanding and recap generation

FROM python:3.11-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app

# ============================================================
# BUILDER
# ============================================================
FROM base AS builder

COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# ============================================================
# RUNNER
# ============================================================
FROM base AS runner

COPY --from=builder /root/.local /home/appuser/.local
ENV PATH=/home/appuser/.local/bin:$PATH

COPY --chown=appuser:appuser app.py .

USER appuser

EXPOSE 8003

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:8003/health || exit 1

ENTRYPOINT ["dumb-init", "--"]

CMD ["python", "app.py"]