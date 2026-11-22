#!/bin/bash
# Health check script for all InstantCap services
# Usage: ./healthcheck.sh [service_name]

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
TIMEOUT=5
MAX_RETRIES=3

# Service endpoints
declare -A SERVICES=(
    ["nginx"]="http://localhost/nginx-health"
    ["nextjs"]="http://localhost:3000/api/health"
    ["mongodb-primary"]="mongodb://localhost:27018"
    ["mongodb-secondary"]="mongodb://localhost:27017"
    ["mongodb-arbiter"]="mongodb://localhost:27017"
    ["redis"]="redis://localhost:6379"
    ["minio"]="http://localhost:19002/minio/health/live"
    ["asr-worker"]="http://localhost:8001/health"
    ["tts-worker"]="http://localhost:8002/health"
    ["ai-worker"]="http://localhost:8003/health"
    ["render-worker"]="http://localhost:8004/health"
)

# Print usage
usage() {
    echo "Usage: $0 [service_name|all]"
    echo "Services: ${!SERVICES[@]}"
    exit 1
}

# Check HTTP endpoint
check_http() {
    local name=$1
    local url=$2
    local retries=0

    while [ $retries -lt $MAX_RETRIES ]; do
        if curl -sf --max-time $TIMEOUT "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}✓${NC} $name: Healthy"
            return 0
        fi
        retries=$((retries + 1))
        sleep 1
    done

    echo -e "${RED}✗${NC} $name: Unhealthy (failed after $MAX_RETRIES retries)"
    return 1
}

# Check MongoDB
check_mongodb() {
    local name=$1
    local uri=$2

    if command -v mongosh > /dev/null 2>&1; then
        if mongosh "$uri" --eval "db.adminCommand('ping')" --quiet > /dev/null 2>&1; then
            echo -e "${GREEN}✓${NC} $name: Healthy"
            return 0
        fi
    elif command -v mongo > /dev/null 2>&1; then
        if mongo "$uri" --eval "db.adminCommand('ping')" --quiet > /dev/null 2>&1; then
            echo -e "${GREEN}✓${NC} $name: Healthy"
            return 0
        fi
    else
        # Fallback: try nc
        if nc -z localhost 27017 > /dev/null 2>&1; then
            echo -e "${YELLOW}⚠${NC} $name: Port open (mongosh not available for full check)"
            return 0
        fi
    fi

    echo -e "${RED}✗${NC} $name: Unhealthy"
    return 1
}

# Check Redis
check_redis() {
    local name=$1
    local uri=$2

    if command -v redis-cli > /dev/null 2>&1; then
        if redis-cli -u "$uri" ping > /dev/null 2>&1; then
            echo -e "${GREEN}✓${NC} $name: Healthy"
            return 0
        fi
    else
        # Fallback: try nc
        if nc -z localhost 6379 > /dev/null 2>&1; then
            echo -e "${YELLOW}⚠${NC} $name: Port open (redis-cli not available for full check)"
            return 0
        fi
    fi

    echo -e "${RED}✗${NC} $name: Unhealthy"
    return 1
}

# Check single service
check_service() {
    local name=$1
    local endpoint=${SERVICES[$name]}

    if [ -z "$endpoint" ]; then
        echo -e "${RED}✗${NC} Unknown service: $name"
        return 1
    fi

    case $name in
        mongodb-*)
            check_mongodb "$name" "$endpoint"
            ;;
        redis)
            check_redis "$name" "$endpoint"
            ;;
        *)
            check_http "$name" "$endpoint"
            ;;
    esac
}

# Main
main() {
    local target=${1:-all}
    local failed=0
    local total=0

    echo "========================================="
    echo "InstantCap Health Check"
    echo "========================================="

    if [ "$target" = "all" ]; then
        for service in "${!SERVICES[@]}"; do
            total=$((total + 1))
            check_service "$service" || failed=$((failed + 1))
        done
    else
        total=1
        check_service "$target" || failed=1
    fi

    echo "========================================="
    if [ $failed -eq 0 ]; then
        echo -e "${GREEN}All $total service(s) healthy${NC}"
        exit 0
    else
        echo -e "${RED}$failed of $total service(s) unhealthy${NC}"
        exit 1
    fi
}

main "$@"
