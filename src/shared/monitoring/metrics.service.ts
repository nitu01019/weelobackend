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
  sum: Map<string, number>;
  count: Map<string, number>;
}

// =============================================================================
// METRICS STORAGE
// =============================================================================

class MetricsService {
  private counters: Map<string, CounterMetric> = new Map();
  private gauges: Map<string, GaugeMetric> = new Map();
  private histograms: Map<string, HistogramMetric> = new Map();
  
  // Pre-defined histogram buckets (in milliseconds for latency)
  private readonly latencyBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  
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
    setInterval(() => {
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
      histogram.sum.set(labelKey, 0);
      histogram.count.set(labelKey, 0);
    }
    
    // Add value (keep last 1000 for percentile calculation)
    const values = histogram.values.get(labelKey)!;
    values.push(value);
    if (values.length > 1000) {
      values.shift();
    }
    
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
      
      for (const [labelKey, values] of histogram.values) {
        const sortedValues = [...values].sort((a, b) => a - b);
        const count = histogram.count.get(labelKey) || 0;
        const sum = histogram.sum.get(labelKey) || 0;
        
        // Calculate bucket counts
        let cumulative = 0;
        for (const bucket of histogram.buckets) {
          cumulative = sortedValues.filter(v => v <= bucket).length;
          const labelPart = labelKey ? `${labelKey},` : '';
          lines.push(`${histogram.name}_bucket{${labelPart}le="${bucket}"} ${cumulative}`);
        }
        
        // +Inf bucket
        const labelPart = labelKey ? `${labelKey},` : '';
        lines.push(`${histogram.name}_bucket{${labelPart}le="+Inf"} ${count}`);
        lines.push(`${histogram.name}_sum{${labelKey || ''}} ${sum}`);
        lines.push(`${histogram.name}_count{${labelKey || ''}} ${count}`);
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
  
  // ===========================================================================
  // HELPERS
  // ===========================================================================
  
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
  
  // Increment active requests
  metrics.incrementGauge('http_active_requests');
  
  // Capture response
  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e6;
    const labels = {
      method: req.method,
      path: getRoutePath(req),
      status: String(res.statusCode)
    };
    
    // Record metrics
    metrics.incrementCounter('http_requests_total', labels);
    metrics.observeHistogram('http_request_duration_ms', duration, labels);
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
