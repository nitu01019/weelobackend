/**
 * =============================================================================
 * PRODUCTION CONFIGURATION - AWS Deployment Ready
 * =============================================================================
 * 
 * Configuration for deploying to AWS with:
 * - ECS/Fargate for containers
 * - ElastiCache for Redis
 * - RDS for database (future)
 * - ALB for load balancing
 * - CloudWatch for logging
 * 
 * SCALABILITY SETTINGS:
 * - Connection pooling
 * - Rate limiting
 * - Cache TTLs
 * - WebSocket limits
 * 
 * =============================================================================
 */

export const productionConfig = {
  // ===========================================================================
  // SERVER
  // ===========================================================================
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    trustProxy: true, // Behind ALB/CloudFront
    requestTimeout: 30000, // 30s max request time
    keepAliveTimeout: 65000, // Must be > ALB idle timeout (60s)
    headersTimeout: 66000
  },
  
  // ===========================================================================
  // CORS - Configure for your domains
  // ===========================================================================
  cors: {
    origins: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    credentials: true,
    maxAge: 86400 // 24 hours preflight cache
  },
  
  // ===========================================================================
  // RATE LIMITING - Prevents abuse
  // ===========================================================================
  rateLimit: {
    // Global limits
    global: {
      windowMs: 60000, // 1 minute
      max: 100 // 100 requests per minute per IP
    },
    // Auth endpoints (stricter)
    auth: {
      windowMs: 60000,
      max: 10 // 10 auth attempts per minute
    },
    // Booking/Order creation (stricter)
    booking: {
      windowMs: 60000,
      max: 20 // 20 bookings per minute per user
    },
    // WebSocket connections
    websocket: {
      maxConnectionsPerUser: 5,
      reconnectCooldownMs: 1000
    }
  },
  
  // ===========================================================================
  // CACHING - Redis/In-Memory
  // ===========================================================================
  cache: {
    // Redis connection (AWS ElastiCache)
    redis: {
      enabled: process.env.REDIS_ENABLED === 'true',
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      maxRetries: 3,
      connectTimeout: 5000,
      commandTimeout: 3000
    },
    // In-memory cache (fallback)
    memory: {
      maxSize: 10000, // Max entries
      defaultTTL: 300 // 5 minutes default
    },
    // TTL settings (seconds)
    ttl: {
      transportersByVehicle: 300, // 5 min - transporter lookups
      userProfile: 3600, // 1 hour - user data
      fcmToken: 604800, // 7 days - push tokens
      otp: 300, // 5 min - OTP codes
      refreshToken: 604800, // 7 days - refresh tokens
      activeBookings: 30 // 30 sec - active booking lists
    }
  },
  
  // ===========================================================================
  // DATABASE
  // ===========================================================================
  database: {
    // Current: JSON file storage
    // Future: PostgreSQL/MySQL on RDS
    type: process.env.DB_TYPE || 'json',
    
    // PostgreSQL settings (for future migration)
    postgres: {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME,
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      pool: {
        min: 5,
        max: 20,
        acquireTimeout: 30000,
        idleTimeout: 10000
      },
      ssl: process.env.DB_SSL === 'true'
    }
  },
  
  // ===========================================================================
  // WEBSOCKET - Socket.IO settings
  // ===========================================================================
  websocket: {
    // Connection settings
    pingTimeout: 30000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6, // 1MB max message
    
    // Scaling (Redis adapter for multi-server)
    adapter: process.env.REDIS_ENABLED === 'true' ? 'redis' : 'memory',
    
    // Room limits
    maxRoomsPerSocket: 10,
    
    // Transports
    transports: ['websocket', 'polling'],
    upgradeTimeout: 10000
  },
  
  // ===========================================================================
  // PUSH NOTIFICATIONS - FCM
  // ===========================================================================
  fcm: {
    batchSize: 500, // FCM limit per batch
    retries: 3,
    retryDelay: 1000,
    timeout: 10000
  },
  
  // ===========================================================================
  // SECURITY
  // ===========================================================================
  security: {
    // JWT settings
    jwt: {
      accessTokenExpiry: '15m',
      refreshTokenExpiry: '7d',
      algorithm: 'HS256'
    },
    
    // Request validation
    maxRequestSize: '10mb',
    maxUrlLength: 2048,
    
    // Headers
    helmet: {
      contentSecurityPolicy: true,
      crossOriginEmbedderPolicy: false, // For maps/images
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    }
  },
  
  // ===========================================================================
  // LOGGING - CloudWatch ready
  // ===========================================================================
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
    
    // Request logging
    requestLogging: {
      enabled: true,
      excludePaths: ['/health', '/metrics'],
      includeBody: false, // Don't log request bodies in production
      includeHeaders: false
    },
    
    // Performance logging
    slowRequestThreshold: 1000 // Log requests > 1s
  },
  
  // ===========================================================================
  // MONITORING - Health checks
  // ===========================================================================
  monitoring: {
    healthCheck: {
      path: '/health',
      timeout: 5000
    },
    metrics: {
      enabled: process.env.METRICS_ENABLED === 'true',
      path: '/metrics'
    }
  },
  
  // ===========================================================================
  // BROADCAST SETTINGS
  // ===========================================================================
  broadcast: {
    timeout: 300000, // 5 minutes default
    maxQueueSize: 1000, // Max pending broadcasts
    
    // Batch settings for high load
    batchSize: 100, // Transporters per batch
    batchDelayMs: 10 // Delay between batches to prevent overload
  }
};

// Export based on environment
export const config = productionConfig;
