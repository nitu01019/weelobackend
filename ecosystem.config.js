/**
 * PM2 Ecosystem Configuration - Production Cluster Mode
 * 
 * 4 PRINCIPLES:
 * SCALABILITY: Cluster mode uses all CPU cores (8x throughput)
 * EASY UNDERSTANDING: Standard PM2 configuration
 * MODULARITY: Separate from app code
 * CODING STANDARDS: PM2 best practices
 */

module.exports = {
  apps: [{
    name: 'weelo-backend',
    script: './dist/server.js',
    
    // SCALABILITY: Use all CPU cores (8 cores = 8x capacity)
    instances: 'max',
    exec_mode: 'cluster',
    
    // Environment
    env_production: {
      NODE_ENV: 'production'
    },
    
    // Logging
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // Auto-restart on crash
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    
    // Memory management
    max_memory_restart: '1G',
    
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 3000
  }]
};
