/**
 * =============================================================================
 * Fix #6 sidecar — `dlq_broadcasts_depth` CloudWatch emitter (30s)
 * =============================================================================
 *
 * Pre-flight gate for `FF_BATCH_QUEUE_DEPTH_GUARD=true`. The depth-guard partial-
 * admit path at `queue.service.ts` pushes overflow ids to `dlq:broadcasts`; the
 * leader-elected `replay-broadcast-dlq` drainer recirculates them. Without this
 * sidecar the matching CloudWatch alarm (`weelo-dlq-broadcasts-depth-warn`)
 * sits in INSUFFICIENT_DATA forever, so a stalled drainer + partial-admit flag
 * flip silently saturates the DLQ (lTrim drops the oldest entries — see
 * `queue.service.ts:2433`).
 *
 * Emits three metrics every 30 seconds to the CW namespace `Weelo/Backend`:
 *  - `dlq_broadcasts_depth`           — LLEN dlq:broadcasts (active retry list)
 *  - `dlq_broadcasts_permanent_depth` — LLEN dlq:broadcasts:permanent (dead-letter)
 *  - `dlq_broadcasts_inflight_depth`  — LLEN dlq:broadcasts:inflight (drainer in-flight)
 *
 * Also mirrors each value into the in-process Prometheus gauge so local
 * dashboards / `/metrics` endpoint stay populated when the AWS SDK is absent.
 *
 * Pattern: dynamic-require for `@aws-sdk/client-cloudwatch` matches
 * `tracking-stream-sink.ts` so dev/test runs with no SDK simply degrade to the
 * Prometheus-only path. No throws, no unhandled rejections.
 *
 * Wired in `server.ts` next to the F-PERF-02 / P9-3 broadcast DLQ drainer.
 *
 * Reference: `index-20-validated.md` §1.3 Fix #6 + §2.1.1 Pillar 4 pre-flight.
 * =============================================================================
 */

import { logger } from './logger.service';
import { redisService } from './redis.service';
import { metrics } from '../monitoring/metrics.service';

const NAMESPACE = process.env.CW_NAMESPACE || 'Weelo/Backend';
const REGION = process.env.AWS_REGION || 'ap-south-1';
const INTERVAL_MS = 30_000;

const ACTIVE_KEY = 'dlq:broadcasts';
const PERMANENT_KEY = 'dlq:broadcasts:permanent';
const INFLIGHT_KEY = 'dlq:broadcasts:inflight';

const ACTIVE_METRIC = 'dlq_broadcasts_depth';
const PERMANENT_METRIC = 'dlq_broadcasts_permanent_depth';
const INFLIGHT_METRIC = 'dlq_broadcasts_inflight_depth';

let cloudwatchClient: any | null = null;
let cloudwatchSdkAvailable: boolean | null = null;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;

/**
 * Lazy-load the CloudWatch SDK. Returns null if `@aws-sdk/client-cloudwatch`
 * is not installed (dev / unit-test environments) — we still emit to the
 * in-process Prometheus gauge in that case so local dashboards see depth.
 */
function getCloudWatchClient(): any | null {
  if (cloudwatchSdkAvailable === false) return null;
  if (cloudwatchClient) return cloudwatchClient;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('@aws-sdk/client-cloudwatch');
    cloudwatchClient = new sdk.CloudWatchClient({ region: REGION });
    cloudwatchSdkAvailable = true;
    return cloudwatchClient;
  } catch (error: unknown) {
    cloudwatchSdkAvailable = false;
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(
      '[DLQDepthEmitter] @aws-sdk/client-cloudwatch unavailable, falling back to Prometheus-only emit',
      { message: msg },
    );
    return null;
  }
}

async function safeLLen(key: string): Promise<number> {
  try {
    return await redisService.lLen(key);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('[DLQDepthEmitter] LLEN failed', { key, message: msg });
    return 0;
  }
}

async function putMetricData(client: any, metricName: string, value: number): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('@aws-sdk/client-cloudwatch');
    const command = new sdk.PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [
        {
          MetricName: metricName,
          Value: value,
          Unit: 'Count',
          Timestamp: new Date(),
        },
      ],
    });
    await client.send(command);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('[DLQDepthEmitter] PutMetricData failed', { metricName, value, message: msg });
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;

  try {
    const [activeDepth, permanentDepth, inflightDepth] = await Promise.all([
      safeLLen(ACTIVE_KEY),
      safeLLen(PERMANENT_KEY),
      safeLLen(INFLIGHT_KEY),
    ]);

    metrics.setGauge(ACTIVE_METRIC, activeDepth);
    metrics.setGauge(PERMANENT_METRIC, permanentDepth);
    metrics.setGauge(INFLIGHT_METRIC, inflightDepth);

    const client = getCloudWatchClient();
    if (!client) return;

    await Promise.all([
      putMetricData(client, ACTIVE_METRIC, activeDepth),
      putMetricData(client, PERMANENT_METRIC, permanentDepth),
      putMetricData(client, INFLIGHT_METRIC, inflightDepth),
    ]);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('[DLQDepthEmitter] tick failed', { message: msg });
  } finally {
    inFlight = false;
  }
}

export interface DlqDepthEmitterHandle {
  stop(): void;
}

/**
 * Start the 30s sampling loop. Idempotent — calling twice returns a handle
 * to the same timer. The interval is `.unref()`'d so it never blocks
 * graceful shutdown. Returns a handle that callers can `.stop()` for tests.
 */
export function startDlqBroadcastsDepthEmitter(): DlqDepthEmitterHandle {
  if (timer) {
    return {
      stop(): void {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      },
    };
  }

  // Fire-and-forget first sample so the alarm transitions out of
  // INSUFFICIENT_DATA on the next 60s evaluation period.
  tick().catch(() => { /* tick already handles its own errors */ });

  timer = setInterval(() => {
    tick().catch(() => { /* tick already handles its own errors */ });
  }, INTERVAL_MS);
  timer.unref?.();

  logger.info(
    `[DLQDepthEmitter] started (every ${INTERVAL_MS / 1000}s, namespace=${NAMESPACE}, region=${REGION})`,
  );

  return {
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
