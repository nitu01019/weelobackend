/**
 * =============================================================================
 * METRICS SERVICE - Application Performance Monitoring
 * =============================================================================
 * 
 * Collects and exposes metrics for monitoring tools like:
 * - Prometheus + Grafana (recommended for production)
 * - AWS CloudWatch
 * - DataDog
 * 
 * METRICS COLLECTED:
 * - HTTP request duration (histogram)
 * - Request count by status code
 * - Active connections (WebSocket)
 * - Database query times
 * - Cache hit/miss ratio
 * - Memory usage
 * - Event loop lag
 * 
 * ENDPOINT: GET /metrics (Prometheus format)
 * 
 * SCALABILITY:
 * - Lightweight in-memory storage
 * - Aggregated metrics (not per-request storage)
 * - Compatible with Prometheus scraping
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.service';

// =============================================================================
// METRIC TYPES
// =============================================================================

interface CounterMetric {
  name: string;
  help: string;
  labels: Record<string, number>;
}

interface GaugeMetric {
  name: string;
  help: string;
  value: number;
}

interface HistogramMetric {
  name: string;
  help: string;
  buckets: number[];
  values: Map<string, number[]>; // label -> array of values
  bucketCounts: Map<string, number[]>; // label -> cumulative counts per bucket +Inf
  sum: Map<string, number>;
  count: Map<string, number>;
}

interface HttpRequestSample {
  timestampMs: number;
  durationMs: number;
  statusCode: number;
  loadTestRunId?: string;
}

// =============================================================================
// METRICS STORAGE
// =============================================================================

class MetricsService {
  private counters: Map<string, CounterMetric> = new Map();
  private gauges: Map<string, GaugeMetric> = new Map();
  private histograms: Map<string, HistogramMetric> = new Map();
  private httpRequestSamples: HttpRequestSample[] = [];
  
  // Pre-defined histogram buckets (in milliseconds for latency)
  private readonly latencyBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  private readonly maxHttpRequestSamples = 40000;
  private readonly maxHttpSampleWindowMs = 15 * 60 * 1000;
  
  constructor() {
    this.initializeDefaultMetrics();
    this.startSystemMetricsCollection();
  }
  
  /**
   * Initialize default metrics
   */
  private initializeDefaultMetrics(): void {
    // HTTP request counter
    this.counters.set('http_requests_total', {
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labels: {}
    });
    
    // HTTP request duration histogram
    this.histograms.set('http_request_duration_ms', {
      name: 'http_request_duration_ms',
      help: 'HTTP request duration in milliseconds',
      buckets: this.latencyBuckets,
      values: new Map(),
      bucketCounts: new Map(),
      sum: new Map(),
      count: new Map()
    });
    
    // Database query counter
    this.counters.set('db_queries_total', {
      name: 'db_queries_total',
      help: 'Total number of database queries',
      labels: {}
    });
    
    // Database query duration
    this.histograms.set('db_query_duration_ms', {
      name: 'db_query_duration_ms',
      help: 'Database query duration in milliseconds',
      buckets: this.latencyBuckets,
      values: new Map(),
      bucketCounts: new Map(),
      sum: new Map(),
      count: new Map()
    });
    
    // Cache metrics
    this.counters.set('cache_hits_total', {
      name: 'cache_hits_total',
      help: 'Total number of cache hits',
      labels: {}
    });
    
    this.counters.set('cache_misses_total', {
      name: 'cache_misses_total',
      help: 'Total number of cache misses',
      labels: {}
    });

    // Load test metrics (correlated by run id)
    this.counters.set('load_test_requests_total', {
      name: 'load_test_requests_total',
      help: 'Total number of requests tagged with X-Load-Test-Run-Id',
      labels: {}
    });

    this.histograms.set('load_test_request_duration_ms', {
      name: 'load_test_request_duration_ms',
      help: 'Load test tagged request duration in milliseconds',
      buckets: this.latencyBuckets,
      values: new Map(),
      bucketCounts: new Map(),
      sum: new Map(),
      count: new Map()
    });
    
    // WebSocket connections
    this.gauges.set('websocket_connections', {
      name: 'websocket_connections',
      help: 'Current number of WebSocket connections',
      value: 0
    });
    
    // Memory usage
    this.gauges.set('nodejs_memory_heap_used_bytes', {
      name: 'nodejs_memory_heap_used_bytes',
      help: 'Node.js heap memory used',
      value: 0
    });
    
    this.gauges.set('nodejs_memory_heap_total_bytes', {
      name: 'nodejs_memory_heap_total_bytes',
      help: 'Node.js total heap memory',
      value: 0
    });
    
    // Event loop lag
    this.gauges.set('nodejs_eventloop_lag_ms', {
      name: 'nodejs_eventloop_lag_ms',
      help: 'Node.js event loop lag in milliseconds',
      value: 0
    });
    
    // Active requests
    this.gauges.set('http_active_requests', {
      name: 'http_active_requests',
      help: 'Number of currently active HTTP requests',
      value: 0
    });
  }
  
  /**
   * Start collecting system metrics periodically
   */
  private startSystemMetricsCollection(): void {
    // Collect every 15 seconds
    const timer = setInterval(() => {
      const memUsage = process.memoryUsage();
      this.setGauge('nodejs_memory_heap_used_bytes', memUsage.heapUsed);
      this.setGauge('nodejs_memory_heap_total_bytes', memUsage.heapTotal);
      
      // Measure event loop lag
      const start = process.hrtime.bigint();
      setImmediate(() => {
        const lag = Number(process.hrtime.bigint() - start) / 1e6; // Convert to ms
        this.setGauge('nodejs_eventloop_lag_ms', lag);
      });
    }, 15000);
    // Prevent this timer from blocking Jest process exit.
    timer.unref();
  }
  
  // ===========================================================================
  // COUNTER METHODS
  // ===========================================================================
  
  /**
   * Increment a counter
   */
  incrementCounter(name: string, labels: Record<string, string> = {}, value: number = 1): void {
    const counter = this.counters.get(name);
    if (!counter) {
      logger.warn(`Counter ${name} not found`);
      return;
    }
    
    const labelKey = this.labelsToKey(labels);
    counter.labels[labelKey] = (counter.labels[labelKey] || 0) + value;
  }
  
  // ===========================================================================
  // GAUGE METHODS
  // ===========================================================================
  
  /**
   * Set a gauge value
   */
  setGauge(name: string, value: number): void {
    const gauge = this.gauges.get(name);
    if (gauge) {
      gauge.value = value;
    }
  }
  
  /**
   * Increment a gauge
   */
  incrementGauge(name: string, value: number = 1): void {
    const gauge = this.gauges.get(name);
    if (gauge) {
      gauge.value += value;
    }
  }
  
  /**
   * Decrement a gauge
   */
  decrementGauge(name: string, value: number = 1): void {
    const gauge = this.gauges.get(name);
    if (gauge) {
      gauge.value = Math.max(0, gauge.value - value);
    }
  }
  
  // ===========================================================================
  // HISTOGRAM METHODS
  // ===========================================================================
  
  /**
   * Observe a value in a histogram
   */
  observeHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const histogram = this.histograms.get(name);
    if (!histogram) {
      logger.warn(`Histogram ${name} not found`);
      return;
    }
    
    const labelKey = this.labelsToKey(labels);
    
    // Initialize if needed
    if (!histogram.values.has(labelKey)) {
      histogram.values.set(labelKey, []);
      histogram.bucketCounts.set(labelKey, new Array(histogram.buckets.length + 1).fill(0));
      histogram.sum.set(labelKey, 0);
      histogram.count.set(labelKey, 0);
    }
    
    // Add value (keep last 1000 for percentile calculation)
    const values = histogram.values.get(labelKey)!;
    values.push(value);
    if (values.length > 1000) {
      values.shift();
    }

    const cumulativeBuckets = histogram.bucketCounts.get(labelKey)!;
    for (let i = 0; i < histogram.buckets.length; i++) {
      if (value <= histogram.buckets[i]) {
        cumulativeBuckets[i] += 1;
      }
    }
    // +Inf bucket is always incremented.
    cumulativeBuckets[histogram.buckets.length] += 1;
    
    histogram.sum.set(labelKey, histogram.sum.get(labelKey)! + value);
    histogram.count.set(labelKey, histogram.count.get(labelKey)! + 1);
  }
  
  /**
   * Create a timer for measuring duration
   */
  startTimer(histogramName: string, labels: Record<string, string> = {}): () => void {
    const start = process.hrtime.bigint();
    return () => {
      const duration = Number(process.hrtime.bigint() - start) / 1e6; // Convert to ms
      this.observeHistogram(histogramName, duration, labels);
    };
  }
  
  // ===========================================================================
  // PROMETHEUS FORMAT EXPORT
  // ===========================================================================
  
  /**
   * Export all metrics in Prometheus format
   */
  getPrometheusMetrics(): string {
    const lines: string[] = [];
    
    // Export counters
    for (const [, counter] of this.counters) {
      lines.push(`# HELP ${counter.name} ${counter.help}`);
      lines.push(`# TYPE ${counter.name} counter`);
      
      for (const [labelKey, value] of Object.entries(counter.labels)) {
        if (labelKey === '') {
          lines.push(`${counter.name} ${value}`);
        } else {
          lines.push(`${counter.name}{${labelKey}} ${value}`);
        }
      }
    }
    
    // Export gauges
    for (const [, gauge] of this.gauges) {
      lines.push(`# HELP ${gauge.name} ${gauge.help}`);
      lines.push(`# TYPE ${gauge.name} gauge`);
      lines.push(`${gauge.name} ${gauge.value}`);
    }
    
    // Export histograms
    for (const [, histogram] of this.histograms) {
      lines.push(`# HELP ${histogram.name} ${histogram.help}`);
      lines.push(`# TYPE ${histogram.name} histogram`);
      
      for (const [labelKey] of histogram.values) {
        const cumulativeBuckets = histogram.bucketCounts.get(labelKey) || [];
        const count = histogram.count.get(labelKey) || 0;
        const sum = histogram.sum.get(labelKey) || 0;
        
        for (let i = 0; i < histogram.buckets.length; i++) {
          const bucket = histogram.buckets[i];
          const cumulative = cumulativeBuckets[i] || 0;
          const labelPart = labelKey ? `${labelKey},` : '';
          lines.push(`${histogram.name}_bucket{${labelPart}le="${bucket}"} ${cumulative}`);
        }
        
        // +Inf bucket
        const labelPart = labelKey ? `${labelKey},` : '';
        const infCount = cumulativeBuckets[histogram.buckets.length] || count;
        lines.push(`${histogram.name}_bucket{${labelPart}le="+Inf"} ${infCount}`);
        if (labelKey) {
          lines.push(`${histogram.name}_sum{${labelKey}} ${sum}`);
          lines.push(`${histogram.name}_count{${labelKey}} ${count}`);
        } else {
          lines.push(`${histogram.name}_sum ${sum}`);
          lines.push(`${histogram.name}_count ${count}`);
        }
      }
    }
    
    return lines.join('\n');
  }
  
  /**
   * Get metrics as JSON (for health endpoint)
   */
  getMetricsJSON(): Record<string, unknown> {
    return {
      counters: Object.fromEntries(
        Array.from(this.counters.entries()).map(([name, c]) => [name, c.labels])
      ),
      gauges: Object.fromEntries(
        Array.from(this.gauges.entries()).map(([name, g]) => [name, g.value])
      ),
      histograms: Object.fromEntries(
        Array.from(this.histograms.entries()).map(([name, h]) => [
          name,
          {
            count: Object.fromEntries(h.count),
            sum: Object.fromEntries(h.sum)
          }
        ])
      )
    };
  }

  /**
   * Record one HTTP request sample for short SLO windows.
   * Keeps an in-memory sliding window (last 15 minutes max).
   */
  recordHttpRequestSample(sample: HttpRequestSample): void {
    this.httpRequestSamples.push(sample);
    if (this.httpRequestSamples.length > this.maxHttpRequestSamples) {
      this.httpRequestSamples.shift();
    }
    this.pruneHttpRequestSamples(sample.timestampMs);
  }

  /**
   * Summarize HTTP latency + error rate for a recent window.
   * Uses in-process samples captured by metricsMiddleware.
   */
  getHttpSloSummary(windowMinutes: number = 5, loadTestRunId?: string): {
    windowMinutes: number;
    sampleCount: number;
    p95Ms: number;
    p99Ms: number;
    avgMs: number;
    errorRate5xxPct: number;
    windowStart: string;
    windowEnd: string;
    loadTestRunId?: string;
  } {
    const now = Date.now();
    const effectiveWindowMinutes = Math.min(Math.max(windowMinutes, 1), 15);
    const windowStartMs = now - effectiveWindowMinutes * 60_000;

    this.pruneHttpRequestSamples(now);

    const relevant = this.httpRequestSamples.filter((sample) => {
      if (sample.timestampMs < windowStartMs) return false;
      if (!loadTestRunId) return true;
      return sample.loadTestRunId === loadTestRunId;
    });

    const durations = relevant.map((s) => s.durationMs).sort((a, b) => a - b);
    const sampleCount = relevant.length;
    const errorCount5xx = relevant.filter((s) => s.statusCode >= 500).length;
    const totalDuration = relevant.reduce((sum, s) => sum + s.durationMs, 0);

    return {
      windowMinutes: effectiveWindowMinutes,
      sampleCount,
      p95Ms: this.percentile(durations, 0.95),
      p99Ms: this.percentile(durations, 0.99),
      avgMs: sampleCount > 0 ? totalDuration / sampleCount : 0,
      errorRate5xxPct: sampleCount > 0 ? (errorCount5xx / sampleCount) * 100 : 0,
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(now).toISOString(),
      ...(loadTestRunId && { loadTestRunId })
    };
  }
  
  // ===========================================================================
  // HELPERS
  // ===========================================================================
  
  private pruneHttpRequestSamples(nowMs: number): void {
    const minTimestamp = nowMs - this.maxHttpSampleWindowMs;
    while (this.httpRequestSamples.length > 0 && this.httpRequestSamples[0].timestampMs < minTimestamp) {
      this.httpRequestSamples.shift();
    }
  }

  private percentile(sortedValues: number[], q: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.ceil(sortedValues.length * q) - 1;
    const boundedIndex = Math.max(0, Math.min(index, sortedValues.length - 1));
    return sortedValues[boundedIndex];
  }

  private labelsToKey(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
  }
}

// Singleton instance
export const metrics = new MetricsService();

// =============================================================================
// EXPRESS MIDDLEWARE
// =============================================================================

/**
 * Middleware to track HTTP request metrics
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = process.hrtime.bigint();
  const routePath = getRoutePath(req);
  const loadTestRunId = normalizeRunId(req.headers['x-load-test-run-id']);
  
  // Increment active requests
  metrics.incrementGauge('http_active_requests');
  
  // Capture response
  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e6;
    const labels = {
      method: req.method,
      path: routePath,
      status: String(res.statusCode)
    };
    
    // Record metrics
    metrics.incrementCounter('http_requests_total', labels);
    metrics.observeHistogram('http_request_duration_ms', duration, labels);
    metrics.recordHttpRequestSample({
      timestampMs: Date.now(),
      durationMs: duration,
      statusCode: res.statusCode,
      loadTestRunId: loadTestRunId || undefined
    });

    if (loadTestRunId) {
      const loadLabels = {
        run_id: loadTestRunId,
        method: req.method,
        path: routePath,
        status: String(res.statusCode)
      };
      metrics.incrementCounter('load_test_requests_total', loadLabels);
      metrics.observeHistogram('load_test_request_duration_ms', duration, loadLabels);
    }

    metrics.decrementGauge('http_active_requests');
  });
  
  next();
}

/**
 * Get normalized route path (replace IDs with placeholders)
 */
function getRoutePath(req: Request): string {
  // Use the matched route if available
  if (req.route?.path) {
    return req.baseUrl + req.route.path;
  }
  
  // Normalize dynamic segments
  return req.path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

function normalizeRunId(headerValue: unknown): string {
  if (typeof headerValue !== 'string') return '';
  return headerValue
    .trim()
    .slice(0, 64)
    .replace(/[^a-zA-Z0-9._:-]/g, '_');
}

/**
 * Metrics endpoint handler
 */
export function metricsHandler(_req: Request, res: Response): void {
  res.set('Content-Type', 'text/plain');
  res.send(metrics.getPrometheusMetrics());
}

/**
 * Track database query metrics
 */
export function trackDbQuery(operation: string, duration: number): void {
  metrics.incrementCounter('db_queries_total', { operation });
  metrics.observeHistogram('db_query_duration_ms', duration, { operation });
}

/**
 * Track cache operations
 */
export function trackCacheHit(): void {
  metrics.incrementCounter('cache_hits_total');
}

export function trackCacheMiss(): void {
  metrics.incrementCounter('cache_misses_total');
}

/**
 * Track WebSocket connections
 */
export function trackWebSocketConnection(delta: number): void {
  if (delta > 0) {
    metrics.incrementGauge('websocket_connections', delta);
  } else {
    metrics.decrementGauge('websocket_connections', Math.abs(delta));
  }
}
