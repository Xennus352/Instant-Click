# InstantCap

InstantCap is a web application for managing movie recap projects with Burmese transcription, recap writing, narration, subtitles, and video rendering. The repository contains the application and worker pipeline code; each stage runs only when its required services are ready. Uploads remain blocked until a scanner confirms the source is clean. Gemini is the text model, Nara SAR is the speech-recognition model, and Nara Mini is the narration model.

This repository does not include a malware scanner or production deployment configuration. See [the current architecture](docs/architecture.md) and [the pipeline contract](docs/ai-pipeline-api.md) for implementation boundaries and readiness gates.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        INSTANTCAP                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐                  │
│  │  NGINX   │───▶│  NEXT.JS │───▶│  REDIS   │                  │
│  │ (Proxy)  │    │ (API+UI) │    │ (Queue)  │                  │
│  └──────────┘    └────┬─────┘    └──────────┘                  │
│                       │                                         │
│         ┌─────────────┼─────────────┐                           │
│         ▼             ▼             ▼                           │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐  │
│  │ ASR WORKER │ │ TTS WORKER │ │ AI WORKER  │ │ RENDER WKR │  │
│  │ (Nara SAR) │ │(Nara Mini) │ │ (Gemini)   │ │ (FFmpeg)   │  │
│  └─────┬──────┘ └─────┬──────┘ └────┬───────┘ └─────┬──────┘  │
│        │              │        └──────┬───────┘       │        │
│        └──────────────┼───────────────┼───────────────┘        │
│                       ▼               ▼                         │
│              ┌────────────────┐ ┌────────────┐                 │
│              │   MONGODB      │ │  MINIO/S3  │                 │
│              │  (Replica Set) │ │ (Objects)  │                 │
│              └────────────────┘ └────────────┘                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start (Development)

### Prerequisites

- Docker & Docker Compose v2+
- Node.js 22+ (for local development)
- Python 3.11+ (for worker development)

### Start Development Environment

```bash
# Clone and navigate
cd instantcap

# Copy the development environment template, then replace its placeholders.
cp .env.example .env.dev

# Start all services
docker compose --env-file .env.dev -f docker-compose.yml -f docker-compose.dev.yml up -d

# Check service health
./scripts/healthcheck.sh all
```

### Service URLs (Development)

| Service | URL |
|---------|-----|
| Frontend + API | http://localhost:3000 |
| Health Check | http://localhost:3000/api/health |
| MinIO Console | http://localhost:9001 |
| ASR Worker | http://localhost:8001/health |
| TTS Worker | http://localhost:8002/health |
| AI Worker | http://localhost:8003/health |
| Render Worker | http://localhost:8004/health |

### Stop Development Environment

```bash
docker compose --env-file .env.dev -f docker-compose.yml -f docker-compose.dev.yml down
```

The command above preserves named database and object-storage volumes. Add `-v` only when you intentionally want to erase local development data.

## Project Structure

```
instantcap/
├── docker-compose.yml          # Base docker-compose configuration
├── docker-compose.dev.yml      # Development overrides
├── .env.example                # Environment template
├── .gitignore
├── nginx/
│   ├── nginx.conf              # Main nginx config
│   └── conf.d/
│       ├── dev.conf            # Development routing
│       └── prod.conf           # Production routing (TLS)
├── services/
│   ├── nextjs/                 # Next.js application (API + Frontend)
│   │   ├── Dockerfile          # Production Dockerfile
│   │   ├── Dockerfile.dev      # Development Dockerfile
│   │   ├── package.json
│   │   ├── next.config.js
│   │   ├── tsconfig.json
│   │   ├── tailwind.config.js
│   │   ├── postcss.config.js
│   │   ├── prisma/
│   │   │   └── schema.prisma   # Database schema
│   │   └── src/
│   │       ├── app/
│   │       │   ├── api/health/route.ts
│   │       │   ├── layout.tsx
│   │       │   ├── page.tsx
│   │       │   └── globals.css
│   │       └── ...
│   ├── asr-worker/             # Nara SAR ASR service
│   │   ├── Dockerfile
│   │   ├── Dockerfile.dev
│   │   ├── requirements.txt
│   │   └── app.py
│   ├── tts-worker/             # Nara Mini TTS service
│   │   ├── Dockerfile
│   │   ├── Dockerfile.dev
│   │   ├── requirements.txt
│   │   └── app.py
│   ├── ai-worker/              # Gemini movie analysis and recap text
│   │   ├── Dockerfile
│   │   ├── Dockerfile.dev
│   │   ├── requirements.txt
│   │   └── app.py
│   ├── render-worker/          # FFmpeg video rendering
│   │   ├── Dockerfile
│   │   ├── Dockerfile.dev
│   │   ├── requirements.txt
│   │   └── app.py
│   └── ffmpeg/                 # FFmpeg utility image
│       └── Dockerfile
├── scripts/
│   ├── healthcheck.sh          # Service health checks
│   └── entrypoint.sh           # Service initialization
└── .github/
    └── workflows/
        └── ci.yml              # CI/CD pipeline
```

## Environment Variables

Copy `.env.example` to `.env.dev` and replace its placeholder credentials before starting Compose. Keep the MongoDB URI and MongoDB root username/password in sync, and use matching S3/MinIO access values. Do not reuse development values in production. Key categories:

- **Application**: `APP_URL`, `NODE_ENV`
- **Database**: `DATABASE_URL` (MongoDB replica set)
- **Redis**: `REDIS_URL`
- **Object Storage**: `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`
- **Authentication**: `AUTH_SECRET`, OAuth provider keys
- **Text generation**: `GEMINI_API_KEY`, `GEMINI_MODEL`
- **Speech models**: Nara SAR and Nara Mini paths under `MODEL_CACHE_DIR`
- **Workers**: `ORT_THREADS`, `ORT_PROVIDERS`, `FFMPEG_THREADS`

Downloaded model files are excluded from Git. Install the Hugging Face CLI, then run `scripts/download-nara-models.sh download-all` and `scripts/download-nara-models.sh verify` when local ASR/TTS inference is needed. Gemini and model availability are reported by worker readiness endpoints. The external scanner gate is described in `docs/ai-pipeline-api.md`; no scanner implementation is included here.

## Development Workflow

### Adding New Dependencies

```bash
# Next.js
cd services/nextjs
npm install <package>
# Update Dockerfile.dev if needed for native deps

# Python Workers
cd services/asr-worker  # or tts-worker, ai-worker, render-worker
echo "<package>" >> requirements.txt
# Rebuild: docker compose build asr-worker
```

### MongoDB Schema and Prisma Client

```bash
# Generate Prisma client
cd services/nextjs
npm run prisma:generate

# Synchronize the Prisma schema with the selected MongoDB database
npx prisma db push
```

Prisma Migrate is not supported for MongoDB. Run `db push` only against the intended development database; review and back up any populated database before changing its schema. See the [Prisma MongoDB guide](https://www.prisma.io/docs/v7/prisma-orm/add-to-existing-project/mongodb).

### Running Tests

```bash
# Next.js tests
cd services/nextjs
npm test
npm run test:watch
npm run test:coverage
```

## CI and Image Publishing

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs checks on pushes and pull requests:

1. **Lint & Type Check** - ESLint, TypeScript, Prettier
2. **Unit Tests** - Jest with coverage
3. **Prisma Validation** - Schema validation & client generation
4. **Docker Build (Dev)** - Build dev images, run health checks
5. **Docker Build (Prod)** - Build & push production images (main branch only)
6. **Security Scan** - Trivy image scanning

On pushes to `main`, the workflow also builds and publishes production container images to GHCR. Its `Deploy Staging` job currently only prints a placeholder message; it does not deploy an application. No Vercel workflow is configured.

## Production Deployment

Production deployment has not been configured in this repository. A future deployment plan would need:
- Docker Swarm or Kubernetes cluster
- TLS certificates (Let's Encrypt or Cloudflare)
- Secrets management (HashiCorp Vault or cloud KMS)
- External MongoDB, Redis, S3 (or managed equivalents)
- Monitoring stack (Prometheus, Grafana, Loki)

Do not treat the development Compose files or the placeholder staging job as production deployment instructions.

## Architecture and API Documents

- [Current repository architecture](docs/architecture.md)
- [Pipeline and worker API](docs/ai-pipeline-api.md)
- [Admin API](docs/admin-api.md)
- [Billing API](docs/billing-api.md)
- [Dinger payment integration notes](docs/dinger-payments.md)
- [Project upload API](docs/project-upload-api.md)

## License

No application-level license file is present yet. Downloaded Nara model artifacts have their own upstream licenses and notices; keep those notices with the artifacts when redistributing them.
