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

import { Router, Request, Response } from 'express';
import os from 'os';
import { metrics, metricsHandler } from '../monitoring/metrics.service';
import { circuitBreakerRegistry } from '../resilience/circuit-breaker';
import { defaultQueue, bookingQueue, trackingQueue, authQueue } from '../resilience/request-queue';
import { cacheService } from '../services/cache.service';
import { logger } from '../services/logger.service';

const router = Router();

// Track server start time
const startTime = Date.now();

/**
 * Basic health check - for load balancers
 * Returns 200 if server is running, nothing else
 */
router.get('/health', (_req: Request, res: Response) => {
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
      const cacheHealthy = await cacheService.ping();
      checks.cache = cacheHealthy;
    } catch {
      checks.cache = false;
    }
    
    // Check circuit breakers
    const circuitBreakers = circuitBreakerRegistry.getAllStats();
    const openCircuits = circuitBreakers.filter(cb => cb.state === 'OPEN');
    checks.circuits = openCircuits.length === 0;
    
    // Determine overall status
    const isReady = Object.values(checks).every(v => v);
    
    res.status(isReady ? 200 : 503).json({
      status: isReady ? 'ready' : 'not_ready',
      checks,
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
 * Detailed health - full system status
 * Internal use only, provides comprehensive diagnostics
 */
router.get('/health/detailed', async (_req: Request, res: Response) => {
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
    
    metrics: metrics.getMetricsJSON()
  };
  
  res.json(healthStatus);
});

/**
 * Prometheus metrics endpoint
 */
router.get('/metrics', metricsHandler);

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
