/**
 * =============================================================================
 * ENVIRONMENT CONFIGURATION
 * =============================================================================
 * 
 * Centralized configuration loaded from environment variables.
 * All config access goes through this file - no direct process.env usage elsewhere.
 * 
 * SECURITY:
 * - No secrets are logged or exposed in error messages
 * - Production requires proper JWT secrets (validated at startup)
 * - Development uses auto-generated secrets if not provided
 * 
 * SCALABILITY:
 * - Redis configuration for distributed caching
 * - Stateless design ready for horizontal scaling
 * 
 * FOR BACKEND DEVELOPERS:
 * - Add new config here, not scattered across the codebase
 * - Use getRequired() for mandatory production values
 * - Use getOptional() for values with sensible defaults
 * =============================================================================
 */

import dotenv from 'dotenv';
import { randomBytes } from 'crypto';

// Load .env file
dotenv.config();

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get required environment variable (throws if missing in production)
 */
function getRequired(key: string, devDefault?: string): string {
  const value = process.env[key];
  
  if (value && value.trim() !== '') {
    return value;
  }
  
  // In development, use default or generate secure value
  if (process.env.NODE_ENV !== 'production') {
    if (devDefault) {
      console.warn(`⚠️  [CONFIG] ${key} not set, using development default`);
      return devDefault;
    }
    // Auto-generate secure secret for development
    const generated = randomBytes(32).toString('hex');
    console.warn(`⚠️  [CONFIG] ${key} not set, auto-generated for development`);
    return generated;
  }
  
  // In production, this is a fatal error
  throw new Error(
    `❌ FATAL: ${key} is required in production!\n` +
    `   Generate a secure value with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"\n` +
    `   Then set it in your environment variables or .env file.`
  );
}

/**
 * Get optional environment variable with default
 */
function getOptional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Get boolean environment variable
 */
function getBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

/**
 * Get number environment variable
 */
function getNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse CORS origins from comma-separated string
 */
function parseCorsOrigins(value: string): string | string[] {
  if (value === '*') return '*';
  return value.split(',').map(origin => origin.trim()).filter(Boolean);
}

// =============================================================================
// CONFIGURATION OBJECT
// =============================================================================

/**
 * Application configuration object
 * All configuration is validated at startup
 */
export const config = {
  // Server
  nodeEnv: getOptional('NODE_ENV', 'development'),
  port: getNumber('PORT', 3000),
  host: getOptional('HOST', 'localhost'),

  // Database
  databaseUrl: getOptional('DATABASE_URL', 'postgresql://localhost:5432/weelo_db'),

  // Redis (Required for production scalability)
  redis: {
    enabled: getBoolean('REDIS_ENABLED', false),
    url: getOptional('REDIS_URL', 'redis://localhost:6379'),
  },

  // JWT - SECURITY CRITICAL
  // These are auto-generated in development, REQUIRED in production
  jwt: {
    secret: getRequired('JWT_SECRET'),
    expiresIn: getOptional('JWT_EXPIRES_IN', '7d'),
    refreshSecret: getRequired('JWT_REFRESH_SECRET'),
    refreshExpiresIn: getOptional('JWT_REFRESH_EXPIRES_IN', '30d'),
  },

  // OTP
  otp: {
    expiryMinutes: getNumber('OTP_EXPIRY_MINUTES', 5),
    length: getNumber('OTP_LENGTH', 6),
    maxAttempts: getNumber('OTP_MAX_ATTEMPTS', 3),
  },

  // SMS Provider
  // Options: console (dev), twilio, msg91, aws-sns
  // For AWS deployment: use 'aws-sns' - it uses IAM role automatically on ECS
  sms: {
    provider: getOptional('SMS_PROVIDER', 'console'),
    twilio: {
      accountSid: getOptional('TWILIO_ACCOUNT_SID', ''),
      authToken: getOptional('TWILIO_AUTH_TOKEN', ''),
      phoneNumber: getOptional('TWILIO_PHONE_NUMBER', ''),
    },
    msg91: {
      authKey: getOptional('MSG91_AUTH_KEY', ''),
      senderId: getOptional('MSG91_SENDER_ID', 'WEELO'),
      templateId: getOptional('MSG91_TEMPLATE_ID', ''),
    },
    awsSns: {
      // Region must match AWS deployment region (ap-south-1 for India)
      region: getOptional('AWS_SNS_REGION', 'ap-south-1'),
      // On AWS ECS/EC2, leave empty - uses IAM Task Role automatically
      // Only set for local development testing
      accessKeyId: getOptional('AWS_ACCESS_KEY_ID', ''),
      secretAccessKey: getOptional('AWS_SECRET_ACCESS_KEY', ''),
    },
  },

  // Google Maps
  googleMaps: {
    apiKey: getOptional('GOOGLE_MAPS_API_KEY', ''),
    enabled: getOptional('GOOGLE_MAPS_API_KEY', '').length > 0,
  },

  // Rate Limiting
  rateLimit: {
    windowMs: getNumber('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000), // 15 minutes
    maxRequests: getNumber('RATE_LIMIT_MAX_REQUESTS', 100),
  },

  // Logging
  logLevel: getOptional('LOG_LEVEL', 'debug'),

  // CORS - Parsed into array for production
  cors: {
    origin: parseCorsOrigins(getOptional('CORS_ORIGIN', '*')),
  },

  // Helpers
  isProduction: getOptional('NODE_ENV', 'development') === 'production',
  isDevelopment: getOptional('NODE_ENV', 'development') === 'development',
  isTest: getOptional('NODE_ENV', 'development') === 'test',
  
  // Security Features
  security: {
    enableHeaders: getBoolean('ENABLE_SECURITY_HEADERS', true),
    enableRateLimiting: getBoolean('ENABLE_RATE_LIMITING', true),
    enableRequestLogging: getBoolean('ENABLE_REQUEST_LOGGING', true),
  },
} as const;

// =============================================================================
// STARTUP VALIDATION
// =============================================================================

/**
 * Validate configuration at startup
 * Fails fast if critical config is missing
 */
function validateConfig(): void {
  const warnings: string[] = [];
  const errors: string[] = [];
  
  // Production-specific checks
  if (config.isProduction) {
    // CORS must not be wildcard in production
    if (config.cors.origin === '*') {
      warnings.push('CORS_ORIGIN is set to "*" - this should be restricted in production');
    }

    // Google Maps should be configured for Places search
    if (!config.googleMaps.enabled) {
      errors.push('GOOGLE_MAPS_API_KEY is required in production for Places/Geocoding');
    }
    
    // Redis should be enabled for scalability
    if (!config.redis.enabled) {
      warnings.push('REDIS_ENABLED is false - enable Redis for horizontal scaling');
    }
    
    // SMS provider should be configured
    if (config.sms.provider === 'console') {
      warnings.push('SMS_PROVIDER is "console" - configure Twilio or MSG91 for real SMS');
    }
  }
  
  // Log warnings
  if (warnings.length > 0) {
    console.warn('\n⚠️  Configuration Warnings:');
    warnings.forEach(w => console.warn(`   - ${w}`));
    console.warn('');
  }
  
  // Throw on errors
  if (errors.length > 0) {
    throw new Error(`Configuration Errors:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
}

// Run validation
validateConfig();

// =============================================================================
// CONFIGURATION SUMMARY (for backend developers)
// =============================================================================
/**
 * QUICK REFERENCE:
 * 
 * 1. JWT Secrets (REQUIRED in production):
 *    Generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
 *    
 * 2. Redis (REQUIRED for millions of users):
 *    REDIS_ENABLED=true
 *    REDIS_URL=redis://username:password@host:port
 *    
 * 3. CORS (REQUIRED for security):
 *    CORS_ORIGIN=https://weelo.app,https://captain.weelo.app
 *    
 * 4. SMS Provider (REQUIRED for real OTPs):
 *    SMS_PROVIDER=twilio (or msg91)
 *    + provider-specific credentials
 */
