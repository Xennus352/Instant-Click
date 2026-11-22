#!/bin/bash
# Entrypoint script for InstantCap services
# Handles initialization, migrations, and graceful startup

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Logging functions
log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Wait for a service to be ready
wait_for_service() {
    local host=$1
    local port=$2
    local service_name=$3
    local max_attempts=${4:-30}
    local attempt=1

    log_info "Waiting for $service_name at $host:$port..."

    while [ $attempt -le $max_attempts ]; do
        if nc -z "$host" "$port" > /dev/null 2>&1; then
            log_info "$service_name is ready"
            return 0
        fi
        sleep 2
        attempt=$((attempt + 1))
    done

    log_error "$service_name at $host:$port not ready after $max_attempts attempts"
    return 1
}

# Run database migrations
run_migrations() {
    if [ -f "prisma/schema.prisma" ]; then
        log_info "Running Prisma migrations..."
        npx prisma migrate deploy
        log_info "Migrations completed"
    fi
}

# Generate Prisma client
generate_prisma() {
    if [ -f "prisma/schema.prisma" ]; then
        log_info "Generating Prisma client..."
        npx prisma generate
        log_info "Prisma client generated"
    fi
}

# Initialize S3-compatible buckets
init_s3_buckets() {
    local endpoint="${S3_ENDPOINT:-http://minio:9000}"
    log_info "Initializing S3 buckets at ${endpoint}..."
    for bucket in instantcap instantcap-uploads instantcap-audio instantcap-transcripts instantcap-scripts instantcap-narration instantcap-subtitles instantcap-renders instantcap-thumbnails instantcap-temp; do
        aws --endpoint-url="${endpoint}" s3 mb "s3://${bucket}" 2>/dev/null || true
    done
    log_info "S3 buckets initialized"
}

# Create default admin config
init_admin_config() {
    log_info "Initializing admin configuration..."
    # This would typically be done via a seed script
    # Placeholder for now
    log_info "Admin config initialization skipped (run seed script separately)"
}

# Seed default voice presets
seed_voice_presets() {
    log_info "Seeding voice presets..."
    # This would be done via Prisma seed script
    log_info "Voice presets seeding skipped (run seed script separately)"
}

# Main entrypoint
main() {
    local service_name=${SERVICE_NAME:-unknown}

    log_info "Starting $service_name..."

    # Wait for dependencies based on service
    case $service_name in
        nextjs)
            wait_for_service mongodb-primary 27017 "MongoDB Primary"
            wait_for_service redis 6379 "Redis"
            wait_for_service minio 9000 "S3 storage"
            generate_prisma
            run_migrations
            ;;
        asr-worker|tts-worker|ai-worker|render-worker)
            wait_for_service redis 6379 "Redis"
            wait_for_service minio 9000 "S3 storage"
            ;;
        minio)
            # Object storage doesn't need to wait for others
            ;;
        mongodb-primary|mongodb-secondary|mongodb-arbiter)
            # MongoDB nodes don't need to wait
            ;;
        redis)
            # Redis doesn't need to wait
            ;;
        nginx)
            wait_for_service nextjs 3000 "Next.js"
            ;;
    esac

    log_info "$service_name initialization complete, starting application..."

    # Execute the actual command
    exec "$@"
}

# Handle signals gracefully
trap 'log_info "Received shutdown signal, stopping..."; exit 0' SIGTERM SIGINT

main "$@"
