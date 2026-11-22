#!/bin/bash
# S3/MinIO CORS and bucket policy verification script
# Usage: ./check-s3-cors.sh [endpoint] [access_key] [secret_key] [region]

set -euo pipefail

ENDPOINT="${1:-http://localhost:19002}"
ACCESS_KEY="${2:-minioadmin}"
SECRET_KEY="${3:-minioadmin}"
REGION="${4:-us-east-1}"
export AWS_ACCESS_KEY_ID="$ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$SECRET_KEY"
export AWS_DEFAULT_REGION="$REGION"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

if ! command -v aws >/dev/null 2>&1; then
    log_error "AWS CLI is required for bucket existence checks; CORS headers can be checked directly with curl."
    exit 2
fi

# Buckets to check
BUCKETS=(
    "instantcap"
    "instantcap-uploads"
    "instantcap-audio"
    "instantcap-transcripts"
    "instantcap-scripts"
    "instantcap-narration"
    "instantcap-subtitles"
    "instantcap-renders"
    "instantcap-thumbnails"
    "instantcap-temp"
)

check_cors() {
    local bucket=$1
    log_info "Checking CORS for bucket: $bucket"

    local allowed_origin
    allowed_origin=$(curl -sS -D - -o /dev/null -X OPTIONS \
        -H "Origin: http://localhost:3000" \
        -H "Access-Control-Request-Method: PUT" \
        -H "Access-Control-Request-Headers: Content-Type" \
        "$ENDPOINT/$bucket/cors-check" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "access-control-allow-origin:" { print $2 }' | tail -n 1)
    if [[ "$allowed_origin" == "http://localhost:3000" ]]; then
        log_info "  ✓ Allowed origin is restricted to http://localhost:3000"
        return 0
    else
        log_error "  ✗ Expected localhost origin, received: ${allowed_origin:-no CORS header}"
        return 1
    fi
}

check_preflight() {
    local bucket=$1
    log_info "Testing CORS preflight (OPTIONS) for: $bucket"

    local response=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS \
        -H "Origin: http://localhost:3000" \
        -H "Access-Control-Request-Method: PUT" \
        -H "Access-Control-Request-Headers: Content-Type,Authorization" \
        "$ENDPOINT/$bucket/test-object" 2>/dev/null || echo "000")

    if [[ "$response" == "200" || "$response" == "204" ]]; then
        log_info "  ✓ Preflight successful (HTTP $response)"
        return 0
    else
        log_warn "  ✗ Preflight failed (HTTP $response)"
        return 1
    fi
}

check_rejects_foreign_origin() {
    local bucket=$1
    local allowed_origin
    allowed_origin=$(curl -sS -D - -o /dev/null -X OPTIONS \
        -H "Origin: https://example.invalid" \
        -H "Access-Control-Request-Method: PUT" \
        -H "Access-Control-Request-Headers: Content-Type" \
        "$ENDPOINT/$bucket/cors-check" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "access-control-allow-origin:" { print $2 }' | tail -n 1)
    if [[ -z "$allowed_origin" ]]; then
        log_info "  ✓ Foreign origin receives no Access-Control-Allow-Origin header"
        return 0
    fi
    log_error "  ✗ Foreign origin was allowed: $allowed_origin"
    return 1
}

check_bucket_exists() {
    local bucket=$1
    if aws --endpoint-url="$ENDPOINT" --region="$REGION" s3api head-bucket --bucket "$bucket" 2>/dev/null; then
        log_info "  ✓ Bucket exists"
        return 0
    else
        log_error "  ✗ Bucket does not exist"
        return 1
    fi
}

main() {
    echo "========================================="
    echo "S3/MinIO CORS & Policy Verification"
    echo "Endpoint: $ENDPOINT"
    echo "========================================="

    local failed=0
    local total=0

    for bucket in "${BUCKETS[@]}"; do
        total=$((total + 1))
        echo ""
        log_info "--- Checking bucket: $bucket ---"

        check_bucket_exists "$bucket" || failed=$((failed + 1))
        check_cors "$bucket" || failed=$((failed + 1))
        check_preflight "$bucket" || failed=$((failed + 1))
        check_rejects_foreign_origin "$bucket" || failed=$((failed + 1))
    done

    echo ""
    echo "========================================="
    if [[ $failed -eq 0 ]]; then
        log_info "All $total buckets passed basic checks"
        exit 0
    else
        log_error "$failed of $total buckets have issues"
        exit 1
    fi
}

main "$@"
