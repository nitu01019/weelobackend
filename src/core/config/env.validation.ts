/**
 * =============================================================================
 * ENVIRONMENT VALIDATION
 * =============================================================================
 * 
 * Validates all required environment variables at startup.
 * Fails fast if configuration is invalid - better than runtime errors.
 * 
 * USAGE:
 * ```typescript
 * // At application startup (server.ts)
 * import { validateEnvironment } from '@core';
 * validateEnvironment(); // Throws if invalid
 * ```
 * 
 * =============================================================================
 */

import { logger } from '../../shared/services/logger.service';

/**
 * Environment variable definition
 */
interface EnvVar {
  name: string;
  required: boolean;
  default?: string;
  validator?: (value: string) => boolean;
  description: string;
}

/**
 * All environment variables with their requirements
 */
const ENV_VARS: EnvVar[] = [
  // ==========================================================================
  // SERVER
  // ==========================================================================
  {
    name: 'NODE_ENV',
    required: false,
    default: 'development',
    validator: (v) => ['development', 'staging', 'production', 'test'].includes(v),
    description: 'Application environment'
  },
  {
    name: 'PORT',
    required: false,
    default: '3000',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) > 0 && parseInt(v) < 65536,
    description: 'Server port number'
  },
  {
    name: 'HOST',
    required: false,
    default: '0.0.0.0',
    description: 'Server host address'
  },

  // ==========================================================================
  // JWT AUTHENTICATION
  // ==========================================================================
  {
    name: 'JWT_SECRET',
    required: true,
    validator: (v) => v.length >= 32,
    description: 'JWT signing secret (min 32 characters)'
  },
  {
    name: 'JWT_REFRESH_SECRET',
    required: true,
    validator: (v) => v.length >= 32,
    description: 'JWT refresh token secret (min 32 characters)'
  },
  {
    name: 'JWT_EXPIRES_IN',
    required: false,
    default: '15m',
    description: 'JWT access token expiry'
  },
  {
    name: 'JWT_REFRESH_EXPIRES_IN',
    required: false,
    default: '7d',
    description: 'JWT refresh token expiry'
  },

  // ==========================================================================
  // DATABASE (Required in production)
  // ==========================================================================
  {
    name: 'DATABASE_URL',
    required: false, // Only required in production
    description: 'PostgreSQL connection string'
  },
  {
    name: 'DB_POOL_MIN',
    required: false,
    default: '5',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 0,
    description: 'Minimum database pool connections'
  },
  {
    name: 'DB_POOL_MAX',
    required: false,
    default: '20',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) > 0,
    description: 'Maximum database pool connections'
  },

  // ==========================================================================
  // REDIS CACHE
  // ==========================================================================
  {
    name: 'REDIS_ENABLED',
    required: false,
    default: 'false',
    validator: (v) => ['true', 'false'].includes(v),
    description: 'Enable Redis caching'
  },
  {
    name: 'REDIS_HOST',
    required: false,
    default: 'localhost',
    description: 'Redis server host'
  },
  {
    name: 'REDIS_PORT',
    required: false,
    default: '6379',
    validator: (v) => !isNaN(parseInt(v)),
    description: 'Redis server port'
  },
  {
    name: 'TRACKING_QUEUE_HARD_LIMIT',
    required: false,
    default: '200000',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) > 0,
    description: 'Hard queue depth cap for tracking telemetry queue'
  },
  {
    name: 'TRACKING_QUEUE_DEPTH_SAMPLE_MS',
    required: false,
    default: '500',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 100,
    description: 'Tracking queue depth sampling interval in milliseconds'
  },
  {
    name: 'REDIS_QUEUE_WORKERS',
    required: false,
    default: '16',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) > 0 && parseInt(v) <= 256,
    description: 'Default Redis queue worker count per queue'
  },
  {
    name: 'REDIS_QUEUE_TRACKING_WORKERS',
    required: false,
    default: '48',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) > 0 && parseInt(v) <= 512,
    description: 'Redis queue worker count for tracking-events queue'
  },
  {
    name: 'REDIS_QUEUE_BLOCKING_POP_TIMEOUT_SEC',
    required: false,
    default: '1',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 1 && parseInt(v) <= 30,
    description: 'Redis BRPOP blocking timeout in seconds'
  },
  {
    name: 'ORDER_TRANSPORTER_FANOUT_QUEUE_ENABLED',
    required: false,
    default: 'true',
    validator: (v) => ['true', 'false'].includes(v),
    description: 'Use queued chunk fanout for high-cardinality transporter socket emits'
  },
  {
    name: 'ORDER_TRANSPORTER_FANOUT_SYNC_THRESHOLD',
    required: false,
    default: '64',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) > 0,
    description: 'Transporter count below which order fanout stays synchronous'
  },
  {
    name: 'ORDER_TRANSPORTER_FANOUT_QUEUE_CHUNK_SIZE',
    required: false,
    default: '500',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 25 && parseInt(v) <= 500,
    description: 'Chunk size for queued transporter fanout batches (25-500)'
  },
  {
    name: 'SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE',
    required: false,
    default: '300',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 25 && parseInt(v) <= 500,
    description: 'Socket.IO room chunk size for multi-user direct emits (25-500)'
  },

  // ==========================================================================
  // SMS PROVIDER
  // ==========================================================================
  {
    name: 'SMS_PROVIDER',
    required: false,
    default: 'mock',
    validator: (v) => ['mock', 'console', 'twilio', 'msg91', 'aws-sns'].includes(v),
    description: 'SMS service provider (mock, console, twilio, msg91, aws-sns)'
  },
  {
    name: 'SMS_RETRIEVER_HASH',
    required: false,
    validator: (v) => v.length === 0 || v.length === 11,
    description: 'Android SMS Retriever app hash (11 chars, optional but recommended for OTP autofill)'
  },
  {
    name: 'TWILIO_ACCOUNT_SID',
    required: false,
    description: 'Twilio Account SID (required if SMS_PROVIDER=twilio)'
  },
  {
    name: 'TWILIO_AUTH_TOKEN',
    required: false,
    description: 'Twilio Auth Token (required if SMS_PROVIDER=twilio)'
  },
  {
    name: 'TWILIO_PHONE_NUMBER',
    required: false,
    description: 'Twilio phone number (required if SMS_PROVIDER=twilio)'
  },

  // ==========================================================================
  // FIREBASE (Push Notifications)
  // ==========================================================================
  {
    name: 'FIREBASE_PROJECT_ID',
    required: false,
    description: 'Firebase project ID'
  },
  {
    name: 'FIREBASE_PRIVATE_KEY',
    required: false,
    description: 'Firebase service account private key'
  },
  {
    name: 'FIREBASE_CLIENT_EMAIL',
    required: false,
    description: 'Firebase service account client email'
  },

  // ==========================================================================
  // AWS (Production)
  // ==========================================================================
  {
    name: 'AWS_REGION',
    required: false,
    default: 'ap-south-1',
    description: 'AWS region'
  },
  {
    name: 'AWS_ACCESS_KEY_ID',
    required: false,
    description: 'AWS access key ID'
  },
  {
    name: 'AWS_SECRET_ACCESS_KEY',
    required: false,
    description: 'AWS secret access key'
  },
  {
    name: 'S3_BUCKET',
    required: false,
    description: 'S3 bucket for file uploads'
  },
  {
    name: 'TRACKING_STREAM_ENABLED',
    required: false,
    default: 'false',
    validator: (v) => ['true', 'false'].includes(v),
    description: 'Enable async tracking stream fanout'
  },
  {
    name: 'TRACKING_STREAM_PROVIDER',
    required: false,
    default: 'none',
    validator: (v) => ['none', 'kinesis'].includes(v.toLowerCase()),
    description: 'Tracking stream sink provider (none or kinesis)'
  },
  {
    name: 'TRACKING_KINESIS_STREAM',
    required: false,
    description: 'Kinesis stream name for tracking telemetry fanout'
  },
  {
    name: 'TRACKING_STREAM_BATCH_SIZE',
    required: false,
    default: '100',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 1 && parseInt(v) <= 500,
    description: 'Tracking stream publish batch size'
  },
  {
    name: 'TRACKING_STREAM_FLUSH_MS',
    required: false,
    default: '250',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 10 && parseInt(v) <= 10000,
    description: 'Tracking stream max flush interval in milliseconds'
  },
  {
    name: 'TRACKING_STREAM_MAX_RETRIES',
    required: false,
    default: '3',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 0 && parseInt(v) <= 10,
    description: 'Tracking stream publish retry attempts'
  },

  // ==========================================================================
  // GOOGLE MAPS (Places, Geocoding, Directions)
  // ==========================================================================
  {
    name: 'GOOGLE_MAPS_API_KEY',
    required: false,
    description: 'Google Maps API key (Places, Geocoding, Directions)'
  },

  // ==========================================================================
  // RATE LIMITING
  // ==========================================================================
  {
    name: 'RATE_LIMIT_WINDOW_MS',
    required: false,
    default: '60000',
    validator: (v) => !isNaN(parseInt(v)),
    description: 'Rate limit window in milliseconds'
  },
  {
    name: 'RATE_LIMIT_MAX_REQUESTS',
    required: false,
    default: '100',
    validator: (v) => !isNaN(parseInt(v)),
    description: 'Maximum requests per window'
  },

  // ==========================================================================
  // CORS
  // ==========================================================================
  {
    name: 'CORS_ORIGIN',
    required: false,
    default: '*',
    description: 'Allowed CORS origins (comma-separated)'
  },

  // ==========================================================================
  // LOGGING
  // ==========================================================================
  {
    name: 'LOG_LEVEL',
    required: false,
    default: 'info',
    validator: (v) => ['error', 'warn', 'info', 'debug'].includes(v),
    description: 'Logging level'
  },

  // ==========================================================================
  // HOLD SYSTEM (PRD 7777)
  // ==========================================================================
  {
    name: 'DRIVER_ACCEPT_TIMEOUT_SECONDS',
    required: false,
    default: '45',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 10 && parseInt(v) <= 120,
    description: 'Driver accept/decline timeout in seconds (PRD 7777: 45s)'
  },
  {
    name: 'CONFIRMED_HOLD_MAX_SECONDS',
    required: false,
    default: '180',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 30 && parseInt(v) <= 600,
    description: 'Maximum confirmed hold duration in seconds'
  },
  {
    name: 'FLEX_HOLD_DURATION_SECONDS',
    required: false,
    default: '90',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 10 && parseInt(v) <= 300,
    description: 'Flex hold base duration in seconds'
  },

  // ==========================================================================
  // ORDER CREATION GUARDS
  // ==========================================================================
  {
    name: 'REQUIRE_IDEMPOTENCY_KEY',
    required: false,
    default: 'true',
    validator: (v) => ['true', 'false'].includes(v),
    description: 'Require x-idempotency-key header on POST /orders (set false during client migration)'
  },
  {
    name: 'ORDER_MAX_CONCURRENT_CREATES',
    required: false,
    default: '200',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 10 && parseInt(v) <= 1000,
    description: 'Max concurrent order creates (Redis backpressure + in-memory fallback)'
  },

  // ==========================================================================
  // FEATURE FLAGS
  // ==========================================================================
  {
    name: 'FF_H3_INDEX_ENABLED',
    required: false,
    default: 'false',
    validator: (v) => ['true', 'false'].includes(v),
    description: 'Enable H3 geo index for transporter lookup'
  },
  {
    name: 'FF_CIRCUIT_BREAKER_ENABLED',
    required: false,
    default: 'true',
    validator: (v) => ['true', 'false'].includes(v),
    description: 'Enable circuit breaker for external API calls'
  },
  {
    name: 'FF_SEQUENCE_DELIVERY_ENABLED',
    required: false,
    default: 'false',
    validator: (v) => ['true', 'false'].includes(v),
    description: 'Enable sequence-numbered socket delivery'
  },
  {
    name: 'FF_DIRECTIONS_API_SCORING_ENABLED',
    required: false,
    default: 'false',
    validator: (v) => ['true', 'false'].includes(v),
    description: 'Enable Google Directions API for candidate scoring'
  },
  {
    name: 'FF_HOLD_DB_ATOMIC_CLAIM',
    required: false,
    default: 'false',
    validator: (v) => ['true', 'false'].includes(v),
    description: 'Enable DB-level atomic hold claim'
  },
  {
    name: 'FF_QUEUE_DEPTH_CAP',
    required: false,
    default: '10000',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 100,
    description: 'Queue depth backpressure cap'
  },
  {
    name: 'FF_LEGACY_BOOKING_PROXY_TO_ORDER',
    required: false,
    default: 'true',
    validator: (v) => ['true', 'false'].includes(v),
    description: 'Proxy legacy booking endpoints to canonical order service'
  },
  {
    name: 'FF_CANCEL_POLICY_TRUCK_V1',
    required: false,
    default: 'true',
    validator: (v) => ['true', 'false'].includes(v),
    description: 'Enable truck cancellation policy v1'
  },

  // ==========================================================================
  // DISPATCH TUNING
  // ==========================================================================
  {
    name: 'DIRECTIONS_API_MAX_QPS',
    required: false,
    default: '450',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 10 && parseInt(v) <= 1000,
    description: 'Google Directions API max QPS per instance'
  },
  {
    name: 'BROADCAST_TIMEOUT_SECONDS',
    required: false,
    default: '120',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 30 && parseInt(v) <= 600,
    description: 'Broadcast timeout for booking expiry'
  },

  // ==========================================================================
  // TRACKING THRESHOLDS
  // ==========================================================================
  {
    name: 'MAX_ARRIVAL_DISTANCE_METERS',
    required: false,
    default: '200',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 50 && parseInt(v) <= 5000,
    description: 'Distance threshold for arrival detection'
  },
  {
    name: 'DRIVER_PROXIMITY_NOTIFICATION_KM',
    required: false,
    default: '2',
    validator: (v) => !isNaN(parseFloat(v)) && parseFloat(v) >= 0.1 && parseFloat(v) <= 50,
    description: 'Distance threshold for driver proximity notifications'
  },

  // ==========================================================================
  // FIREBASE
  // ==========================================================================
  {
    name: 'FIREBASE_SERVICE_ACCOUNT_PATH',
    required: false,
    description: 'Path to Firebase service account JSON file for FCM push notifications'
  },

  // ==========================================================================
  // REDIS
  // ==========================================================================
  {
    name: 'REDIS_PUBSUB_DISABLED',
    required: false,
    default: 'false',
    validator: (v) => ['true', 'false'].includes(v),
    description: 'Disable Redis pub/sub adapter (single-instance mode)'
  },

  // ==========================================================================
  // DEPRECATED (to be removed after H-X1 lands)
  // ==========================================================================
  {
    name: 'ASSIGNMENT_TIMEOUT_MS',
    required: false,
    default: '45000',
    validator: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 5000 && parseInt(v) <= 120000,
    description: 'DEPRECATED: Use DRIVER_ACCEPT_TIMEOUT_SECONDS via hold-config.ts instead'
  },
];

/**
 * Validation result
 */
interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  loaded: Record<string, string>;
}

/**
 * Validate all environment variables
 */
export function validateEnvironment(): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    loaded: {}
  };

  const isProduction = process.env.NODE_ENV === 'production';

  for (const envVar of ENV_VARS) {
    const value = process.env[envVar.name];

    // Check if required
    if (envVar.required && !value) {
      result.valid = false;
      result.errors.push(`Missing required environment variable: ${envVar.name} - ${envVar.description}`);
      continue;
    }

    // Production-specific checks
    if (isProduction) {
      // Database is required in production
      if (envVar.name === 'DATABASE_URL' && !value) {
        result.valid = false;
        result.errors.push('DATABASE_URL is required in production');
      }

      // Google Maps API key is required in production
      if (envVar.name === 'GOOGLE_MAPS_API_KEY' && !value) {
        result.valid = false;
        result.errors.push('GOOGLE_MAPS_API_KEY is required in production for Places/Geocoding');
      }
      
      // Redis should be enabled in production
      if (envVar.name === 'REDIS_ENABLED' && value !== 'true') {
        result.warnings.push('REDIS_ENABLED should be true in production for caching and rate limiting');
      }

      // SMS provider should not be mock in production
      if (envVar.name === 'SMS_PROVIDER' && value === 'mock') {
        result.warnings.push('SMS_PROVIDER is set to mock in production');
      }
    }

    // Apply default if not set
    const finalValue = value || envVar.default;
    if (finalValue) {
      // Validate if validator exists
      if (envVar.validator && !envVar.validator(finalValue)) {
        result.valid = false;
        result.errors.push(`Invalid value for ${envVar.name}: "${finalValue}" - ${envVar.description}`);
        continue;
      }

      // Store loaded value
      result.loaded[envVar.name] = finalValue;

      // NOTE: process.env mutation — kept because downstream code may read process.env
      // directly (e.g., Prisma, Redis clients). The config object in environment.ts
      // also provides these defaults, but removing this could break third-party libs.
      if (!value && envVar.default) {
        process.env[envVar.name] = envVar.default;
      }
    }
  }

  // Provider-specific validation
  if (process.env.SMS_PROVIDER === 'twilio') {
    if (!process.env.TWILIO_ACCOUNT_SID) {
      result.errors.push('TWILIO_ACCOUNT_SID is required when SMS_PROVIDER=twilio');
      result.valid = false;
    }
    if (!process.env.TWILIO_AUTH_TOKEN) {
      result.errors.push('TWILIO_AUTH_TOKEN is required when SMS_PROVIDER=twilio');
      result.valid = false;
    }
    if (!process.env.TWILIO_PHONE_NUMBER) {
      result.errors.push('TWILIO_PHONE_NUMBER is required when SMS_PROVIDER=twilio');
      result.valid = false;
    }
  }
  
  // AWS SNS validation - region is required, credentials are optional (IAM role on AWS)
  if (process.env.SMS_PROVIDER === 'aws-sns') {
    if (!process.env.AWS_SNS_REGION && !process.env.AWS_REGION) {
      result.warnings.push('AWS_SNS_REGION not set, defaulting to ap-south-1');
    }
  }

  // Critical environment variables that must always be present — halt startup if missing
  const criticalVars = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = criticalVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`FATAL: Missing critical env vars: ${missing.join(', ')}`);
  }

  const trackingStreamEnabled = process.env.TRACKING_STREAM_ENABLED === 'true';
  const trackingStreamProvider = (process.env.TRACKING_STREAM_PROVIDER || 'none').toLowerCase();
  if (trackingStreamEnabled) {
    if (trackingStreamProvider === 'none') {
      result.valid = false;
      result.errors.push('TRACKING_STREAM_ENABLED=true requires TRACKING_STREAM_PROVIDER to be set (kinesis)');
    }
    if (trackingStreamProvider === 'kinesis' && !process.env.TRACKING_KINESIS_STREAM) {
      result.valid = false;
      result.errors.push('TRACKING_KINESIS_STREAM is required when TRACKING_STREAM_PROVIDER=kinesis');
    }
  } else if (trackingStreamProvider !== 'none') {
    result.warnings.push('TRACKING_STREAM_PROVIDER is set but TRACKING_STREAM_ENABLED=false; tracking stream remains disabled');
  }

  return result;
}

/**
 * Validate and log results at startup
 * Exits process if validation fails in production
 */
export function validateAndLogEnvironment(): void {
  logger.info('--- ENVIRONMENT VALIDATION ---');

  const result = validateEnvironment();
  const isProduction = process.env.NODE_ENV === 'production';

  // Log errors
  if (result.errors.length > 0) {
    result.errors.forEach(error => {
      logger.error(`Environment validation error: ${error}`);
    });
  }

  // Log warnings
  if (result.warnings.length > 0) {
    result.warnings.forEach(warning => {
      logger.warn(`Environment validation warning: ${warning}`);
    });
  }

  // Log success
  if (result.valid) {
    logger.info('Environment validation passed', {
      mode: process.env.NODE_ENV || 'development',
      port: process.env.PORT || '3000',
      redis: process.env.REDIS_ENABLED === 'true' ? 'Enabled' : 'Disabled',
      smsProvider: process.env.SMS_PROVIDER || 'mock'
    });
  }

  // Exit in production if validation failed
  if (!result.valid && isProduction) {
    logger.error('Environment validation failed in production. Exiting.');
    process.exit(1);
  }

  // Exit in production if there are critical warnings (optional - strict mode)
  // if (result.warnings.length > 0 && isProduction && process.env.STRICT_ENV === 'true') {
  //   logger.error('Environment has warnings and STRICT_ENV is enabled. Exiting.');
  //   process.exit(1);
  // }
}

/**
 * Get a typed environment variable with default
 */
export function getEnv(key: string, defaultValue?: string): string {
  return process.env[key] || defaultValue || '';
}

/**
 * Get a typed number environment variable
 */
export function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Get a typed boolean environment variable
 */
export function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

/**
 * Get an array from comma-separated env var
 */
export function getEnvArray(key: string, defaultValue: string[] = []): string[] {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}
