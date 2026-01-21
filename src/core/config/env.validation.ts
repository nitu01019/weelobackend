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

  // ==========================================================================
  // SMS PROVIDER
  // ==========================================================================
  {
    name: 'SMS_PROVIDER',
    required: false,
    default: 'mock',
    validator: (v) => ['mock', 'twilio', 'msg91', 'aws-sns'].includes(v),
    description: 'SMS service provider'
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
    name: 'CORS_ORIGINS',
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
  }
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

      // Set default in process.env if not already set
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

  return result;
}

/**
 * Validate and log results at startup
 * Exits process if validation fails in production
 */
export function validateAndLogEnvironment(): void {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║                   ENVIRONMENT VALIDATION                           ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  
  const result = validateEnvironment();
  const isProduction = process.env.NODE_ENV === 'production';

  // Log errors
  if (result.errors.length > 0) {
    console.log('');
    console.log('❌ ERRORS:');
    result.errors.forEach(error => {
      console.log(`   • ${error}`);
      logger.error(`Environment validation error: ${error}`);
    });
  }

  // Log warnings
  if (result.warnings.length > 0) {
    console.log('');
    console.log('⚠️  WARNINGS:');
    result.warnings.forEach(warning => {
      console.log(`   • ${warning}`);
      logger.warn(`Environment validation warning: ${warning}`);
    });
  }

  // Log success
  if (result.valid) {
    console.log('');
    console.log('✅ Environment validation passed');
    console.log(`   Mode: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Port: ${process.env.PORT || '3000'}`);
    console.log(`   Redis: ${process.env.REDIS_ENABLED === 'true' ? 'Enabled' : 'Disabled'}`);
    console.log(`   SMS Provider: ${process.env.SMS_PROVIDER || 'mock'}`);
  }

  console.log('');

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
