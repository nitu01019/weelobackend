/**
 * =============================================================================
 * CLUSTER MANAGER - Multi-Core Production Server
 * =============================================================================
 * 
 * Enables horizontal scaling across all CPU cores on a single machine.
 * 
 * WHY CLUSTERING MATTERS FOR MILLIONS OF USERS:
 * - Node.js is single-threaded by default
 * - A single process can't utilize multiple CPU cores
 * - Clustering spawns worker processes (one per core)
 * - Each worker handles requests independently
 * - If one worker crashes, others continue serving
 * 
 * USAGE:
 * - Development: Run server.ts directly (single process)
 * - Production: Run cluster.ts (spawns multiple workers)
 * 
 * COMMAND:
 * - npm run start:cluster (production)
 * - npm run dev (development, no clustering)
 * 
 * SCALABILITY FORMULA:
 * - 1 server with 8 cores = 8x throughput
 * - With AWS Auto Scaling + multiple servers = unlimited horizontal scaling
 * =============================================================================
 */

import cluster from 'cluster';
import os from 'os';
import { logger } from './shared/services/logger.service';

// Number of CPU cores
const numCPUs = os.cpus().length;

// Configurable worker count (default: all cores, or set WORKERS env)
const WORKER_COUNT = parseInt(process.env.WORKERS || '') || numCPUs;

// Track worker restart counts to prevent infinite restart loops
const workerRestarts = new Map<number, { count: number; lastRestart: number }>();
const MAX_RESTARTS = 5;
const RESTART_WINDOW = 60000; // 1 minute

/**
 * Check if a worker should be restarted (prevents crash loops)
 */
function shouldRestartWorker(workerId: number): boolean {
  const now = Date.now();
  const stats = workerRestarts.get(workerId);
  
  if (!stats) {
    workerRestarts.set(workerId, { count: 1, lastRestart: now });
    return true;
  }
  
  // Reset counter if outside the window
  if (now - stats.lastRestart > RESTART_WINDOW) {
    workerRestarts.set(workerId, { count: 1, lastRestart: now });
    return true;
  }
  
  // Check if too many restarts
  if (stats.count >= MAX_RESTARTS) {
    return false;
  }
  
  stats.count++;
  stats.lastRestart = now;
  return true;
}

/**
 * Primary process - manages workers
 */
function runPrimary(): void {
  logger.info(`🚀 Primary process ${process.pid} starting ${WORKER_COUNT} workers...`);
  
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║                                                                    ║');
  console.log('║   🚛  WEELO CLUSTER MODE                                           ║');
  console.log('║   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━     ║');
  console.log(`║   Primary PID:  ${String(process.pid).padEnd(48)}║`);
  console.log(`║   CPU Cores:    ${String(numCPUs).padEnd(48)}║`);
  console.log(`║   Workers:      ${String(WORKER_COUNT).padEnd(48)}║`);
  console.log('║                                                                    ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  console.log('');
  
  // Fork workers
  for (let i = 0; i < WORKER_COUNT; i++) {
    const worker = cluster.fork();
    logger.info(`Worker ${worker.process.pid} started`);
  }
  
  // Handle worker exit
  cluster.on('exit', (worker, code, signal) => {
    const exitReason = signal ? `signal ${signal}` : `code ${code}`;
    logger.warn(`Worker ${worker.process.pid} died (${exitReason})`);
    
    // Restart worker if it didn't exit gracefully
    if (code !== 0 && shouldRestartWorker(worker.id)) {
      logger.info('Starting a new worker...');
      cluster.fork();
    } else if (code !== 0) {
      logger.error(`Worker ${worker.id} exceeded restart limit. Not restarting.`);
    }
  });
  
  // Handle worker online
  cluster.on('online', (worker) => {
    logger.info(`Worker ${worker.process.pid} is online`);
  });
  
  // Handle messages from workers
  cluster.on('message', (worker, message) => {
    // Broadcast messages to all workers if needed
    if (message.type === 'broadcast') {
      for (const id in cluster.workers) {
        cluster.workers[id]?.send(message);
      }
    }
  });
  
  // Graceful shutdown
  const gracefulShutdown = (signal: string) => {
    logger.info(`${signal} received. Shutting down workers...`);
    
    for (const id in cluster.workers) {
      const worker = cluster.workers[id];
      if (worker) {
        worker.send('shutdown');
        worker.disconnect();
      }
    }
    
    // Force exit after 30 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30000);
  };
  
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

/**
 * Worker process - runs the actual server
 */
function runWorker(): void {
  // Import and run the server
  require('./server');
  
  // Listen for shutdown message from primary
  process.on('message', (message) => {
    if (message === 'shutdown') {
      logger.info(`Worker ${process.pid} received shutdown signal`);
      process.exit(0);
    }
  });
}

// =============================================================================
// ENTRY POINT
// =============================================================================

if (cluster.isPrimary) {
  runPrimary();
} else {
  runWorker();
}
