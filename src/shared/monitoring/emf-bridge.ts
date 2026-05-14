// =============================================================================
// Fix #1 — Queue-depth-driven autoscaler — EMF in-process fallback
// =============================================================================
// PART A of the broadcast_queue_depth autoscaling bridge. PART B is the
// CloudWatch alarm + Application AutoScaling Bash script at
// scripts/monitoring/setup-broadcast-queue-depth-alarm.sh.
//
// Default OFF. Sidecar EMF emitter is the primary path (decoupled from
// event-loop saturation). This in-process fallback exists so operators can
// opt-in via FF_EMF_INPROCESS_FALLBACK=true while sidecar infrastructure
// rolls out. CloudWatch Logs metric-extraction parses the EMF JSON written
// to stdout and publishes `broadcast_queue_depth` into the configured
// namespace (default `Weelo/Backend`).

import { metrics } from './metrics.service';
import { logger } from '../services/logger.service';

interface EmfPayload {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<{ Name: string; Unit: string }>;
    }>;
  };
  service: string;
  broadcast_queue_depth: number;
}

let emfBridgeInterval: ReturnType<typeof setInterval> | null = null;

const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 10_000;

/** Emit broadcast_queue_depth as EMF JSON to stdout every ~10 s. */
export function startEmfBroadcastDepthBridge(): void {
  if (emfBridgeInterval) {
    return;
  }
  const enabled = process.env.FF_EMF_INPROCESS_FALLBACK === 'true';
  if (!enabled) {
    return;
  }

  const namespace = process.env.CW_NAMESPACE || 'Weelo/Backend';
  const service = process.env.ECS_SERVICE || 'weelo-backend';
  const parsed = parseInt(process.env.EMF_BRIDGE_INTERVAL_MS || `${DEFAULT_INTERVAL_MS}`, 10);
  const intervalMs = Math.max(MIN_INTERVAL_MS, Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS);

  emfBridgeInterval = setInterval(() => {
    try {
      // Phase 4 Fix #1 — call public MetricsService.getGaugeValue directly.
      // TS surfaces a compile error if metrics.service.ts ever drops this
      // method, preventing silent-zero regressions like the one
      // spec-p4-6 caught during Gate 1 review.
      const depth = metrics.getGaugeValue('broadcast_queue_depth') ?? 0;
      const payload: EmfPayload = {
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [{
            Namespace: namespace,
            Dimensions: [['service']],
            Metrics: [{ Name: 'broadcast_queue_depth', Unit: 'Count' }],
          }],
        },
        service,
        broadcast_queue_depth: depth,
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[EmfBridge] emit failed: ${msg}`);
    }
  }, intervalMs);
  emfBridgeInterval.unref();
  logger.info(`[EmfBridge] in-process broadcast_queue_depth emitter started (every ${intervalMs}ms, ns=${namespace})`);
}

export function stopEmfBroadcastDepthBridge(): void {
  if (emfBridgeInterval) {
    clearInterval(emfBridgeInterval);
    emfBridgeInterval = null;
  }
}
