/**
 * =============================================================================
 * AWS PRODUCTION CONFIGURATION
 * =============================================================================
 * 
 * Configuration for deploying Weelo Backend on AWS infrastructure.
 * 
 * RECOMMENDED AWS ARCHITECTURE:
 * 
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                           AWS ARCHITECTURE                              │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │                                                                         │
 * │   [Route 53 DNS] ──► [CloudFront CDN] ──► [Application Load Balancer]  │
 * │                                                 │                       │
 * │                              ┌──────────────────┼──────────────────┐    │
 * │                              │                  │                  │    │
 * │                              ▼                  ▼                  ▼    │
 * │                         [ECS Fargate]     [ECS Fargate]     [ECS Fargate]
 * │                         Container 1       Container 2       Container N │
 * │                              │                  │                  │    │
 * │                              └──────────────────┼──────────────────┘    │
 * │                                                 │                       │
 * │                                                 ▼                       │
 * │                              ┌──────────────────────────────────┐       │
 * │                              │      [ElastiCache Redis]        │       │
 * │                              │    (Sessions, Cache, Rate Limit)│       │
 * │                              └──────────────────────────────────┘       │
 * │                                                 │                       │
 * │                                                 ▼                       │
 * │                              ┌──────────────────────────────────┐       │
 * │                              │        [RDS PostgreSQL]          │       │
 * │                              │      (Primary + Read Replicas)   │       │
 * │                              └──────────────────────────────────┘       │
 * │                                                                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 * 
 * ESTIMATED COSTS (for millions of users):
 * - ECS Fargate: ~$150-500/month (auto-scaling)
 * - RDS PostgreSQL: ~$100-400/month (db.r5.large with replicas)
 * - ElastiCache Redis: ~$50-150/month
 * - ALB: ~$20-50/month
 * - CloudFront: ~$50-200/month (depending on traffic)
 * - Total: ~$400-1500/month for 1M+ users
 * 
 * =============================================================================
 */

/**
 * AWS Region configuration
 */
export const awsRegions = {
  primary: 'ap-south-1',      // Mumbai (closest to India)
  secondary: 'ap-southeast-1', // Singapore (failover)
  
  // Multi-region for global scale
  regions: [
    { id: 'ap-south-1', name: 'Mumbai', priority: 1 },
    { id: 'ap-southeast-1', name: 'Singapore', priority: 2 },
    { id: 'us-east-1', name: 'N. Virginia', priority: 3 }
  ]
};

/**
 * RDS PostgreSQL Configuration
 */
export const rdsConfig = {
  // Connection settings
  connection: {
    host: process.env.RDS_HOST || 'localhost',
    port: parseInt(process.env.RDS_PORT || '5432'),
    database: process.env.RDS_DATABASE || 'weelo',
    username: process.env.RDS_USERNAME || 'weelo',
    password: process.env.RDS_PASSWORD || '',
    
    // SSL required for production
    ssl: process.env.NODE_ENV === 'production' ? {
      rejectUnauthorized: true,
      ca: process.env.RDS_CA_CERT // AWS RDS CA certificate
    } : false
  },
  
  // Connection pooling (critical for millions of users)
  pool: {
    min: 5,
    max: 50,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    
    // For high traffic, increase these
    // max: 100 for very high load
    // But be aware of RDS connection limits
  },
  
  // Read replicas for scaling reads
  readReplicas: [
    process.env.RDS_READ_REPLICA_1,
    process.env.RDS_READ_REPLICA_2
  ].filter(Boolean),
  
  // Query settings
  query: {
    statementTimeout: 30000,   // 30 seconds max query time
    idleInTransactionTimeout: 60000
  }
};

/**
 * ElastiCache Redis Configuration
 */
export const elastiCacheConfig = {
  // Cluster mode configuration
  cluster: {
    enabled: process.env.REDIS_CLUSTER === 'true',
    nodes: (process.env.REDIS_NODES || '').split(',').filter(Boolean)
  },
  
  // Single node configuration (for non-cluster mode)
  single: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    
    // TLS required for ElastiCache in production
    tls: process.env.NODE_ENV === 'production' ? {} : undefined
  },
  
  // Connection settings
  connection: {
    maxRetriesPerRequest: 3,
    retryDelayMs: 100,
    connectTimeout: 10000,
    commandTimeout: 5000,
    keepAlive: 30000
  },
  
  // Key prefixes for organization
  keyPrefixes: {
    session: 'sess:',
    cache: 'cache:',
    rateLimit: 'rl:',
    otp: 'otp:',
    socketRoom: 'room:',
    lock: 'lock:'
  },
  
  // TTL defaults (in seconds)
  ttl: {
    session: 86400 * 7,    // 7 days
    cache: 3600,           // 1 hour
    otp: 300,              // 5 minutes
    rateLimit: 60,         // 1 minute
    lock: 30               // 30 seconds
  }
};

/**
 * ECS/Container Configuration
 */
export const containerConfig = {
  // Task definition settings
  task: {
    cpu: parseInt(process.env.CONTAINER_CPU || '512'),     // 0.5 vCPU
    memory: parseInt(process.env.CONTAINER_MEMORY || '1024'), // 1 GB
    
    // For high traffic, scale up:
    // cpu: 2048 (2 vCPU)
    // memory: 4096 (4 GB)
  },
  
  // Auto-scaling settings
  autoScaling: {
    minTasks: parseInt(process.env.MIN_TASKS || '2'),
    maxTasks: parseInt(process.env.MAX_TASKS || '10'),
    
    // Scale based on CPU utilization
    cpuTargetUtilization: 70,
    
    // Scale based on memory utilization
    memoryTargetUtilization: 80,
    
    // Scale based on request count
    requestsPerTarget: 1000,
    
    // Cooldown periods (seconds)
    scaleInCooldown: 300,
    scaleOutCooldown: 60
  },
  
  // Health check settings
  healthCheck: {
    path: '/health',
    interval: 30,
    timeout: 10,
    healthyThreshold: 2,
    unhealthyThreshold: 3
  }
};

/**
 * Application Load Balancer Configuration
 */
export const albConfig = {
  // Listener rules
  listeners: {
    http: 80,
    https: 443
  },
  
  // Target group settings
  targetGroup: {
    protocol: 'HTTP',
    port: 3000,
    healthCheckPath: '/health',
    healthCheckInterval: 30,
    healthCheckTimeout: 5,
    healthyThreshold: 2,
    unhealthyThreshold: 3,
    
    // Sticky sessions (if needed)
    stickiness: {
      enabled: false,
      duration: 86400
    }
  },
  
  // Connection settings
  connection: {
    idleTimeout: 60,
    keepAliveTimeout: 65
  }
};

/**
 * CloudWatch Monitoring Configuration
 */
export const cloudWatchConfig = {
  // Log groups
  logGroups: {
    application: '/weelo/application',
    access: '/weelo/access',
    error: '/weelo/error'
  },
  
  // Retention period (days)
  logRetention: parseInt(process.env.LOG_RETENTION_DAYS || '30'),
  
  // Metrics namespace
  metricsNamespace: 'Weelo/Backend',
  
  // Custom metrics to publish
  customMetrics: [
    'ActiveConnections',
    'RequestDuration',
    'DatabaseQueryDuration',
    'CacheHitRate',
    'AuthFailures',
    'BookingCreated',
    'BookingCompleted'
  ],
  
  // Alarms
  alarms: {
    highCPU: {
      threshold: 80,
      evaluationPeriods: 3,
      period: 60
    },
    highMemory: {
      threshold: 85,
      evaluationPeriods: 3,
      period: 60
    },
    highErrorRate: {
      threshold: 5, // 5% error rate
      evaluationPeriods: 2,
      period: 60
    },
    highLatency: {
      threshold: 2000, // 2 seconds p99
      evaluationPeriods: 3,
      period: 60
    }
  }
};

/**
 * S3 Configuration (for file storage)
 */
export const s3Config = {
  bucket: process.env.S3_BUCKET || 'weelo-uploads',
  region: awsRegions.primary,
  
  // Presigned URL expiration (seconds)
  presignedUrlExpiry: 3600,
  
  // Upload limits
  maxFileSize: 10 * 1024 * 1024, // 10 MB
  
  // Allowed file types
  allowedMimeTypes: [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
  ],
  
  // Key prefixes
  keyPrefixes: {
    profilePhotos: 'profiles/',
    vehiclePhotos: 'vehicles/',
    documents: 'documents/',
    receipts: 'receipts/'
  }
};

/**
 * Secrets Manager Configuration
 */
export const secretsConfig = {
  // Secret names in AWS Secrets Manager
  secrets: {
    database: 'weelo/production/database',
    redis: 'weelo/production/redis',
    jwt: 'weelo/production/jwt',
    sms: 'weelo/production/sms',
    fcm: 'weelo/production/fcm'
  },
  
  // Cache secrets for 5 minutes
  cacheSeconds: 300
};

/**
 * Environment-specific configuration
 */
export const awsEnvironmentConfig = {
  development: {
    useLocalServices: true,
    logLevel: 'debug'
  },
  staging: {
    useLocalServices: false,
    logLevel: 'info',
    rds: { ...rdsConfig, pool: { ...rdsConfig.pool, max: 20 } }
  },
  production: {
    useLocalServices: false,
    logLevel: 'warn',
    rds: rdsConfig,
    redis: elastiCacheConfig
  }
};

/**
 * Get current environment configuration
 */
export function getAwsConfig() {
  const env = process.env.NODE_ENV || 'development';
  return awsEnvironmentConfig[env as keyof typeof awsEnvironmentConfig] || awsEnvironmentConfig.development;
}

/**
 * Validate AWS configuration at startup
 */
export function validateAwsConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (process.env.NODE_ENV === 'production') {
    // Required in production
    if (!process.env.RDS_HOST) errors.push('RDS_HOST is required');
    if (!process.env.RDS_PASSWORD) errors.push('RDS_PASSWORD is required');
    if (!process.env.REDIS_HOST) errors.push('REDIS_HOST is required');
    if (!process.env.JWT_SECRET) errors.push('JWT_SECRET is required');
    if (!process.env.JWT_REFRESH_SECRET) errors.push('JWT_REFRESH_SECRET is required');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}
