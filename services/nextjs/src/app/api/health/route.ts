import { NextResponse } from 'next/server';
import Redis from 'ioredis';
import { prisma } from '@/lib/prisma';

// Health is a live dependency probe; never run MongoDB/Redis/S3 checks during
// static generation or cache a previous readiness result.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

export async function GET() {
  const checks = {
    timestamp: new Date().toISOString(),
    status: 'healthy' as 'healthy' | 'degraded' | 'unhealthy',
    services: {
      database: 'unknown' as 'healthy' | 'unhealthy' | 'unknown',
      redis: 'unknown' as 'healthy' | 'unhealthy' | 'unknown',
      objectStorage: 'unknown' as 'healthy' | 'unhealthy' | 'unknown',
    },
  };

  // Check database
  try {
    // Prisma's MongoDB connector does not expose SQL raw queries. A lightweight
    // read proves the database is reachable without requiring any records.
    await prisma.user.findFirst({ select: { id: true } });
    checks.services.database = 'healthy';
  } catch (error) {
    checks.services.database = 'unhealthy';
    checks.status = 'degraded';
  }

  // Check Redis
  try {
    await redis.ping();
    checks.services.redis = 'healthy';
  } catch (error) {
    checks.services.redis = 'unhealthy';
    checks.status = 'degraded';
  }

  // Check S3-compatible object storage.
  try {
    const endpoint = process.env.S3_ENDPOINT;
    if (!endpoint) throw new Error('S3_ENDPOINT is not configured');
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/minio/health/live`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      checks.services.objectStorage = 'healthy';
    } else {
      checks.services.objectStorage = 'unhealthy';
      checks.status = 'degraded';
    }
  } catch (error) {
    checks.services.objectStorage = 'unhealthy';
    checks.status = 'degraded';
  }

  const statusCode = checks.status === 'healthy' ? 200 : 503;
  return NextResponse.json(checks, { status: statusCode });
}
