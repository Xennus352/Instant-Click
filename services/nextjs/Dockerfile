# Next.js Production Dockerfile
# Multi-stage build for minimal production image

# ============================================================
# BASE STAGE
# ============================================================
FROM node:22-alpine AS base

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

WORKDIR /app

# Create non-root user
RUN addgroup -g 1000 -S nodejs && \
    adduser -S nextjs -u 1000 -G nodejs

# ============================================================
# DEPENDENCIES STAGE (for builder - includes devDeps)
# ============================================================
FROM base AS deps

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDeps for Prisma generate and build)
RUN npm ci && \
    npm cache clean --force

# ============================================================
# PRODUCTION DEPENDENCIES STAGE (for runner - only prodDeps)
# ============================================================
FROM base AS prod-deps

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && \
    npm cache clean --force

# ============================================================
# BUILDER STAGE
# ============================================================
FROM base AS builder

# Copy all node_modules from deps (includes devDeps for Prisma)
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY . .

# Generate Prisma client (requires devDeps)
RUN npx prisma generate

# Build the application
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# ============================================================
# RUNNER STAGE
# ============================================================
FROM base AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy built application
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy production node_modules from prod-deps
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules

USER nextjs

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget -q --spider http://localhost:3000/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "server.js"]