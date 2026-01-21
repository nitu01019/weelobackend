"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const crypto_1 = require("crypto");
// Load .env file
dotenv_1.default.config();
// =============================================================================
// HELPER FUNCTIONS
// =============================================================================
/**
 * Get required environment variable (throws if missing in production)
 */
function getRequired(key, devDefault) {
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
        const generated = (0, crypto_1.randomBytes)(32).toString('hex');
        console.warn(`⚠️  [CONFIG] ${key} not set, auto-generated for development`);
        return generated;
    }
    // In production, this is a fatal error
    throw new Error(`❌ FATAL: ${key} is required in production!\n` +
        `   Generate a secure value with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"\n` +
        `   Then set it in your environment variables or .env file.`);
}
/**
 * Get optional environment variable with default
 */
function getOptional(key, defaultValue) {
    return process.env[key] || defaultValue;
}
/**
 * Get boolean environment variable
 */
function getBoolean(key, defaultValue) {
    const value = process.env[key];
    if (!value)
        return defaultValue;
    return value.toLowerCase() === 'true';
}
/**
 * Get number environment variable
 */
function getNumber(key, defaultValue) {
    const value = process.env[key];
    if (!value)
        return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
}
/**
 * Parse CORS origins from comma-separated string
 */
function parseCorsOrigins(value) {
    if (value === '*')
        return '*';
    return value.split(',').map(origin => origin.trim()).filter(Boolean);
}
// =============================================================================
// CONFIGURATION OBJECT
// =============================================================================
/**
 * Application configuration object
 * All configuration is validated at startup
 */
exports.config = {
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
};
// =============================================================================
// STARTUP VALIDATION
// =============================================================================
/**
 * Validate configuration at startup
 * Fails fast if critical config is missing
 */
function validateConfig() {
    const warnings = [];
    const errors = [];
    // Production-specific checks
    if (exports.config.isProduction) {
        // CORS must not be wildcard in production
        if (exports.config.cors.origin === '*') {
            warnings.push('CORS_ORIGIN is set to "*" - this should be restricted in production');
        }
        // Redis should be enabled for scalability
        if (!exports.config.redis.enabled) {
            warnings.push('REDIS_ENABLED is false - enable Redis for horizontal scaling');
        }
        // SMS provider should be configured
        if (exports.config.sms.provider === 'console') {
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
//# sourceMappingURL=environment.js.map