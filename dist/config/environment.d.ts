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
/**
 * Application configuration object
 * All configuration is validated at startup
 */
export declare const config: {
    readonly nodeEnv: string;
    readonly port: number;
    readonly host: string;
    readonly databaseUrl: string;
    readonly redis: {
        readonly enabled: boolean;
        readonly url: string;
    };
    readonly jwt: {
        readonly secret: string;
        readonly expiresIn: string;
        readonly refreshSecret: string;
        readonly refreshExpiresIn: string;
    };
    readonly otp: {
        readonly expiryMinutes: number;
        readonly length: number;
        readonly maxAttempts: number;
    };
    readonly sms: {
        readonly provider: string;
        readonly twilio: {
            readonly accountSid: string;
            readonly authToken: string;
            readonly phoneNumber: string;
        };
        readonly msg91: {
            readonly authKey: string;
            readonly senderId: string;
            readonly templateId: string;
        };
    };
    readonly rateLimit: {
        readonly windowMs: number;
        readonly maxRequests: number;
    };
    readonly logLevel: string;
    readonly cors: {
        readonly origin: string | string[];
    };
    readonly isProduction: boolean;
    readonly isDevelopment: boolean;
    readonly isTest: boolean;
    readonly security: {
        readonly enableHeaders: boolean;
        readonly enableRateLimiting: boolean;
        readonly enableRequestLogging: boolean;
    };
};
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
//# sourceMappingURL=environment.d.ts.map