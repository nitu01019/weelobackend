/**
 * =============================================================================
 * HEALTH CHECK ROUTES - Production Monitoring Endpoints
 * =============================================================================
 * 
 * Provides endpoints for:
 * - Load balancer health checks (ALB, ECS)
 * - Kubernetes liveness/readiness probes
 * - Monitoring dashboards
 * - Circuit breaker status
 * 
 * ENDPOINTS:
 * - GET /health          - Quick health check (for load balancers)
 * - GET /health/live     - Liveness probe (is the process running?)
 * - GET /health/ready    - Readiness probe (can it accept traffic?)
 * - GET /health/detailed - Full system status (internal use)
 * - GET /metrics         - Prometheus metrics
 * 
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import os from 'os';
import { metrics, metricsHandler } from '../monitoring/metrics.service';
import { circuitBreakerRegistry } from '../resilience/circuit-breaker';
import { defaultQueue, bookingQueue, trackingQueue, authQueue } from '../resilience/request-queue';
import { cacheService } from '../services/cache.service';
import { redisService } from '../services/redis.service';
import { logger } from '../services/logger.service';
import { getConnectionStats, getIO, getRedisAdapterStatus } from '../services/socket.service';
import { smsService } from '../../modules/auth/sms.service';

const router = Router();

// Track server start time
const startTime = Date.now();

// Phase 10: Startup grace period — during first 15s, /health/ready returns 200
// even if Redis isn't connected yet (ECS tasks need time to initialize)
const STARTUP_GRACE_MS = 15_000;

// Phase 10: Import shutdown flag from server.ts
// Uses lazy require to avoid circular dependency
// Handles both variable (boolean) and function (() => boolean) exports
function getIsShuttingDown(): boolean {
  try {
    const val = require('../../server').isShuttingDown;
    return typeof val === 'function' ? val() : val === true;
  } catch {
    return false;
  }
}

/**
 * Token-based auth for sensitive health endpoints.
 * Requires HEALTH_ADMIN_TOKEN env var to be set.
 */
const healthAuthCheck = (req: Request, res: Response, next: NextFunction) => {
  const expected = process.env.HEALTH_ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'Health auth not configured' });
  }
  const token = req.headers['x-health-token'];
  if (!token || token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

/**
 * Basic health check - for load balancers
 * Returns 200 if server is running, nothing else
 */
router.get('/health', (_req: Request, res: Response) => {
  // Phase 10 Issue 3: Return 503 during shutdown so ALB stops routing
  if (getIsShuttingDown()) {
    return res.status(503).json({
      status: 'shutting_down',
      timestamp: new Date().toISOString()
    });
  }

  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

/**
 * Liveness probe - is the process alive?
 * Used by Kubernetes/ECS to restart unhealthy containers
 */
router.get('/health/live', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'alive',
    pid: process.pid,
    uptime: Math.floor((Date.now() - startTime) / 1000)
  });
});

/**
 * Readiness probe - can the service accept traffic?
 * Checks if dependencies (DB, Redis) are available
 */
router.get('/health/ready', async (_req: Request, res: Response) => {
  try {
    const checks: Record<string, boolean> = {};

    // Check cache/Redis
    try {
      // Test cache by setting and getting a test value
      await cacheService.set('health_check', 'ok', 10);
      const testValue = await cacheService.get('health_check');
      checks.cache = testValue === 'ok';
    } catch {
      checks.cache = false;
    }

    // Check Redis connectivity (real Redis vs in-memory fallback)
    try {
      checks.redis = redisService.isConnected();
      // If using real Redis, do a PING to verify it's responsive
      if (redisService.isRedisEnabled()) {
        const pingStart = Date.now();
        await redisService.set('health:ping', 'pong', 10);
        const pingResult = await redisService.get('health:ping');
        const pingMs = Date.now() - pingStart;
        checks.redis = pingResult === 'pong';
        // Log slow Redis responses (>50ms PING is concerning)
        if (pingMs > 50) {
          logger.warn(`⚠️ Redis PING took ${pingMs}ms (expected <5ms)`);
        }
      }
    } catch {
      checks.redis = false;
    }

    // Check circuit breakers
    const circuitBreakers = circuitBreakerRegistry.getAllStats();
    const openCircuits = circuitBreakers.filter(cb => cb.state === 'OPEN');
    checks.circuits = openCircuits.length === 0;

    // Socket adapter readiness (for cross-instance fanout in ECS)
    const adapterStatus = getRedisAdapterStatus();
    if (redisService.isRedisEnabled() && process.env.REDIS_PUBSUB_DISABLED !== 'true') {
      // If pub/sub is unsupported by the managed Redis mode, we allow readiness
      // and rely on HTTP + fallback paths instead of marking the whole task unready.
      checks.socketPubSub = adapterStatus.enabled || adapterStatus.mode === 'disabled_by_capability';
    } else {
      checks.socketPubSub = true;
    }

    // Determine overall status
    const isReady = Object.values(checks).every(v => v);

    // Phase 10: Startup grace period — first 15s always ready
    // ECS tasks need time to connect to Redis/Prisma after boot.
    // Without this, ALB marks brand-new tasks as unhealthy immediately.
    const isInGracePeriod = (Date.now() - startTime) < STARTUP_GRACE_MS;
    const finalReady = isReady || isInGracePeriod;

    res.status(finalReady ? 200 : 503).json({
      status: finalReady ? 'ready' : 'not_ready',
      checks,
      ...(isInGracePeriod && !isReady ? { note: 'startup_grace_period' } : {}),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Health check failed', { error });
    res.status(503).json({
      status: 'error',
      message: 'Health check failed'
    });
  }
});

/**
 * SLO snapshot for recent HTTP window.
 * Query params:
 * - windowMinutes (1..15, default 5)
 * - loadTestRunId (optional)
 */
router.get('/health/slo', (req: Request, res: Response) => {
  const windowMinutesRaw = Number(req.query.windowMinutes);
  const windowMinutes = Number.isFinite(windowMinutesRaw) ? windowMinutesRaw : 5;
  const loadTestRunId = typeof req.query.loadTestRunId === 'string'
    ? req.query.loadTestRunId
    : undefined;

  const summary = metrics.getHttpSloSummary(windowMinutes, loadTestRunId);
  const hasSufficientData = summary.sampleCount > 0;
  const isHealthy = hasSufficientData && summary.errorRate5xxPct <= 0.5 && summary.p99Ms <= 1200;

  res.status(200).json({
    status: hasSufficientData ? (isHealthy ? 'healthy' : 'degraded') : 'insufficient_data',
    targets: {
      maxErrorRate5xxPct: 0.5,
      maxP99Ms: 1200
    },
    summary
  });
});

/**
 * Detailed health - full system status
 * Internal use only, provides comprehensive diagnostics
 */
router.get('/health/detailed', healthAuthCheck, async (_req: Request, res: Response) => {
  const memUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();

  // Calculate uptime
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const uptimeFormatted = formatUptime(uptimeSeconds);

  // Get queue stats
  const queueStats = {
    default: defaultQueue.getStats(),
    booking: bookingQueue.getStats(),
    tracking: trackingQueue.getStats(),
    auth: authQueue.getStats()
  };

  // Get circuit breaker stats
  const circuitBreakers = circuitBreakerRegistry.getAllStats();

  // Build response
  const healthStatus = {
    status: 'healthy',
    version: process.env.npm_package_version || '2.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),

    server: {
      pid: process.pid,
      uptime: uptimeFormatted,
      uptimeSeconds,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    },

    system: {
      hostname: os.hostname(),
      cpuCores: os.cpus().length,
      totalMemory: formatBytes(os.totalmem()),
      freeMemory: formatBytes(os.freemem()),
      loadAverage: os.loadavg()
    },

    process: {
      memory: {
        heapUsed: formatBytes(memUsage.heapUsed),
        heapTotal: formatBytes(memUsage.heapTotal),
        external: formatBytes(memUsage.external),
        rss: formatBytes(memUsage.rss)
      },
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system
      }
    },

    queues: queueStats,

    circuitBreakers: circuitBreakers.reduce((acc, cb) => {
      acc[cb.name] = {
        state: cb.state,
        failures: cb.failures,
        successes: cb.successes
      };
      return acc;
    }, {} as Record<string, unknown>),

    metrics: metrics.getMetricsJSON(),

    // SCALABILITY: SMS delivery metrics for production monitoring
    sms: smsService.getMetrics()
  };

  res.json(healthStatus);
});

/**
 * Prometheus metrics endpoint
 */
router.get('/metrics', healthAuthCheck, metricsHandler);

/**
 * Version endpoint
 */
router.get('/version', (_req: Request, res: Response) => {
  res.json({
    name: 'weelo-backend',
    version: process.env.npm_package_version || '2.0.0',
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    buildTime: process.env.BUILD_TIME || 'unknown',
    commitHash: process.env.COMMIT_HASH || 'unknown'
  });
});

/**
 * WebSocket debug endpoint - shows connected users
 * CRITICAL for debugging broadcast issues!
 */
router.get('/health/websocket', healthAuthCheck, (_req: Request, res: Response) => {
  const io = getIO();
  const stats = getConnectionStats();
  const adapterStatus = getRedisAdapterStatus();

  // Get detailed socket info
  const connectedSockets: any[] = [];
  if (io) {
    io.sockets.sockets.forEach((socket) => {
      connectedSockets.push({
        socketId: socket.id,
        userId: socket.data.userId || 'unknown',
        role: socket.data.role || 'unknown',
        phone: socket.data.phone || 'unknown',
        rooms: [...socket.rooms],
        connected: socket.connected
      });
    });
  }

  res.json({
    status: io ? 'initialized' : 'NOT INITIALIZED',
    stats,
    adapter: adapterStatus,
    connectedSockets,
    socketCount: connectedSockets.length,
    message: connectedSockets.length === 0
      ? '⚠️ NO SOCKETS CONNECTED! Broadcasts will not be received in real-time.'
      : `✅ ${connectedSockets.length} socket(s) connected`
  });
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(' ');
}

export { router as healthRoutes };
