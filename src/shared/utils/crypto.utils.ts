/**
 * =============================================================================
 * CRYPTOGRAPHIC UTILITIES
 * =============================================================================
 * 
 * Secure cryptographic functions for the Weelo backend.
 * Uses Node.js built-in crypto module for all security-sensitive operations.
 * 
 * SECURITY BEST PRACTICES:
 * - Uses crypto.randomInt() for OTP generation (cryptographically secure)
 * - Uses crypto.randomBytes() for token generation
 * - Uses crypto.timingSafeEqual() for constant-time comparisons
 * - Never uses Math.random() for security-sensitive operations
 * 
 * SCALABILITY:
 * - All functions are stateless and can run on any server instance
 * - No shared state between calls
 * 
 * @module crypto.utils
 * =============================================================================
 */

import { randomInt, randomBytes, timingSafeEqual, createHash } from 'crypto';

/**
 * Generate a cryptographically secure OTP (One-Time Password)
 * 
 * WHY THIS IS SECURE:
 * - Uses crypto.randomInt() which is cryptographically secure
 * - Math.random() is NOT secure and should NEVER be used for OTPs
 * - Each digit has equal probability (no bias)
 * 
 * @param length - Number of digits (default: 6)
 * @returns A random numeric OTP string
 * 
 * @example
 * const otp = generateSecureOTP();      // "847291"
 * const otp8 = generateSecureOTP(8);    // "84729163"
 */
export function generateSecureOTP(length: number = 6): string {
  // Validate length
  if (length < 4 || length > 10) {
    throw new Error('OTP length must be between 4 and 10 digits');
  }
  
  // Calculate min and max for the given length
  const min = Math.pow(10, length - 1);  // 100000 for 6 digits
  const max = Math.pow(10, length) - 1;  // 999999 for 6 digits
  
  // Generate cryptographically secure random number
  return randomInt(min, max + 1).toString();
}

/**
 * Generate a cryptographically secure random token
 * 
 * USE CASES:
 * - JWT secrets
 * - API keys
 * - Session tokens
 * - Password reset tokens
 * 
 * @param bytes - Number of random bytes (default: 32 = 256 bits)
 * @returns Hex-encoded random string
 * 
 * @example
 * const token = generateSecureToken();     // 64-char hex string
 * const token128 = generateSecureToken(64); // 128-char hex string
 */
export function generateSecureToken(bytes: number = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Generate a cryptographically secure random string (URL-safe)
 * 
 * USE CASES:
 * - Verification links
 * - Short codes
 * - File names
 * 
 * @param length - Length of the output string
 * @returns URL-safe random string
 */
export function generateSecureString(length: number = 32): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  let result = '';
  
  for (let i = 0; i < length; i++) {
    result += charset[bytes[i] % charset.length];
  }
  
  return result;
}

/**
 * Constant-time string comparison to prevent timing attacks
 * 
 * WHY THIS IS IMPORTANT:
 * - Regular string comparison (===) can leak information via timing
 * - Attackers can guess characters by measuring response time
 * - This function takes the same time regardless of where strings differ
 * 
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns true if strings are equal, false otherwise
 * 
 * @example
 * // Use for comparing tokens, OTPs, passwords
 * if (secureCompare(userOTP, storedOTP)) {
 *   // Valid OTP
 * }
 */
export function secureCompare(a: string, b: string): boolean {
  // If lengths differ, we still need to do a comparison to prevent timing leaks
  // But we know the result will be false
  if (a.length !== b.length) {
    // Compare with itself to maintain constant time
    const dummy = Buffer.from(a);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  
  return timingSafeEqual(bufA, bufB);
}

/**
 * Hash a value using SHA-256
 * 
 * USE CASES:
 * - Hashing tokens for storage (so raw token isn't stored)
 * - Creating fingerprints
 * - Checksums
 * 
 * NOTE: For passwords, use bcrypt instead (has salt and is slow by design)
 * 
 * @param value - Value to hash
 * @returns SHA-256 hash as hex string
 */
export function sha256Hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Generate a secure JWT secret
 * 
 * Call this once during setup to generate production secrets:
 * node -e "console.log(require('./dist/shared/utils/crypto.utils').generateJWTSecret())"
 * 
 * @returns A 64-byte (512-bit) hex-encoded secret suitable for HS512
 */
export function generateJWTSecret(): string {
  return randomBytes(64).toString('hex');
}

/**
 * Mask sensitive data for logging
 * 
 * @param value - Value to mask
 * @param visibleStart - Characters to show at start (default: 2)
 * @param visibleEnd - Characters to show at end (default: 2)
 * @returns Masked string
 * 
 * @example
 * maskForLogging("9876543210")  // "98****10"
 * maskForLogging("secret-key")  // "se****ey"
 */
export function maskForLogging(
  value: string,
  visibleStart: number = 2,
  visibleEnd: number = 2
): string {
  if (!value || value.length <= visibleStart + visibleEnd) {
    return '****';
  }
  
  const start = value.slice(0, visibleStart);
  const end = value.slice(-visibleEnd);
  const masked = '*'.repeat(Math.min(value.length - visibleStart - visibleEnd, 6));
  
  return `${start}${masked}${end}`;
}

/**
 * =============================================================================
 * USAGE EXAMPLES FOR BACKEND DEVELOPER
 * =============================================================================
 * 
 * 1. GENERATING OTPs:
 *    ```typescript
 *    import { generateSecureOTP } from './crypto.utils';
 *    
 *    const otp = generateSecureOTP();  // "847291" - 6 digits
 *    const otp8 = generateSecureOTP(8); // "84729163" - 8 digits
 *    ```
 * 
 * 2. GENERATING TOKENS:
 *    ```typescript
 *    import { generateSecureToken } from './crypto.utils';
 *    
 *    const token = generateSecureToken();  // For reset links, API keys, etc.
 *    ```
 * 
 * 3. COMPARING SECRETS SAFELY:
 *    ```typescript
 *    import { secureCompare } from './crypto.utils';
 *    
 *    // DON'T: if (userToken === storedToken) - vulnerable to timing attacks!
 *    // DO: 
 *    if (secureCompare(userToken, storedToken)) {
 *      // Token is valid
 *    }
 *    ```
 * 
 * 4. GENERATING JWT SECRETS FOR PRODUCTION:
 *    Run this command to generate a secure secret:
 *    ```bash
 *    node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
 *    ```
 *    Then add it to your .env file (never commit to git!)
 * 
 * =============================================================================
 */
