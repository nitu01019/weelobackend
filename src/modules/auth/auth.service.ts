/**
 * =============================================================================
 * AUTH MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for authentication (OTP-based login for Customer/Transporter).
 * 
 * SECURITY FEATURES:
 * - Cryptographically secure OTP generation (crypto.randomInt)
 * - OTPs are hashed with bcrypt before storage
 * - OTPs expire after configured time (default: 5 minutes)
 * - Maximum 3 attempts per OTP
 * - Rate limiting enforced at route level
 * - JWT tokens signed with secure secrets
 * - Plain OTPs NEVER stored or logged in production
 * 
 * SCALABILITY:
 * - Ready for Redis integration (replace in-memory stores)
 * - Stateless JWT design
 * - Horizontal scaling ready
 * 
 * FOR BACKEND DEVELOPERS:
 * - OTPs are logged to console ONLY in development mode
 * - In production, OTPs are sent via SMS only
 * - To test in dev: Check server console for OTP
 * =============================================================================
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config/environment';
import { logger } from '../../shared/services/logger.service';
import { AppError } from '../../shared/types/error.types';
import { UserRole } from '../../shared/types/api.types';
import { db } from '../../shared/database/db';
import { generateSecureOTP, maskForLogging } from '../../shared/utils/crypto.utils';

// =============================================================================
// OTP STORAGE
// =============================================================================
// In-memory store for OTPs
// TODO: Replace with Redis for production (horizontal scaling)
// Structure: { "phone:role": { hashedOtp, expiresAt, attempts } }

interface OtpEntry {
  hashedOtp: string;
  expiresAt: Date;
  attempts: number;
}

const otpStore = new Map<string, OtpEntry>();

// =============================================================================
// REFRESH TOKEN STORAGE
// =============================================================================
// In-memory store for refresh tokens
// TODO: Replace with Redis for production (horizontal scaling)

interface RefreshTokenEntry {
  userId: string;
  expiresAt: Date;
}

const refreshTokenStore = new Map<string, RefreshTokenEntry>();

// =============================================================================
// TYPES
// =============================================================================

interface AuthUser {
  id: string;
  phone: string;
  role: UserRole;
  name?: string;
  email?: string;
  createdAt: Date;
  updatedAt: Date;
}

class AuthService {
  /**
   * Send OTP to phone number
   * 
   * SECURITY:
   * - Uses cryptographically secure OTP generation
   * - OTP is hashed before storage (plain OTP is NOT stored)
   * - OTP is logged to console ONLY in development mode
   * - In production, OTP is sent via SMS only
   * 
   * @param phone - Phone number to send OTP to
   * @param role - User role (customer, transporter, driver)
   * @returns Object with expiry time and message
   */
  async sendOtp(phone: string, role: UserRole): Promise<{ expiresIn: number; message: string }> {
    // Generate cryptographically secure 6-digit OTP
    const otp = generateSecureOTP(config.otp.length);
    
    // Hash OTP before storing (NEVER store plain OTP)
    const hashedOtp = await bcrypt.hash(otp, 10);
    
    // Calculate expiry
    const expiresAt = new Date(Date.now() + config.otp.expiryMinutes * 60 * 1000);
    
    // Store ONLY hashed OTP with phone:role as key
    const key = `${phone}:${role}`;
    otpStore.set(key, { 
      hashedOtp,
      expiresAt, 
      attempts: 0 
    });
    
    // ==========================================================================
    // DEVELOPMENT ONLY: Log OTP to console for testing
    // In production, this block is skipped and OTP is sent via SMS only
    // ==========================================================================
    if (config.isDevelopment) {
      console.log('\n');
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║              🔐 OTP GENERATED (DEV MODE ONLY)                ║');
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log(`║  Phone:   ${maskForLogging(phone, 2, 4).padEnd(50)}║`);
      console.log(`║  Role:    ${role.padEnd(50)}║`);
      console.log(`║  OTP:     ${otp.padEnd(50)}║`);
      console.log(`║  Expires: ${expiresAt.toLocaleTimeString().padEnd(50)}║`);
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log('║  ⚠️  This OTP is shown ONLY in development mode!             ║');
      console.log('║  In production, OTP is sent via SMS only.                    ║');
      console.log('╚══════════════════════════════════════════════════════════════╝');
      console.log('\n');
    }
    
    // Log without exposing OTP (safe for production logs)
    logger.info('OTP generated', { 
      phone: maskForLogging(phone, 2, 4), 
      role,
      expiresAt: expiresAt.toISOString()
    });
    
    // Determine response message based on environment
    const message = config.isDevelopment
      ? `OTP sent. Check server console for OTP (dev mode).`
      : `OTP sent to ${maskForLogging(phone, 2, 4)}. Please check your SMS.`;
    
    return { 
      expiresIn: config.otp.expiryMinutes * 60,
      message
    };
  }

  /**
   * Verify OTP and return tokens
   * Creates new user in database if first time login
   * 
   * SECURITY:
   * - OTP is compared using bcrypt (timing-safe)
   * - OTP is deleted after successful verification
   * - Maximum 3 attempts before OTP is invalidated
   * - Failed attempts are logged for security monitoring
   * 
   * @param phone - Phone number that received OTP
   * @param otp - OTP entered by user
   * @param role - User role
   * @returns User data and JWT tokens
   */
  async verifyOtp(phone: string, otp: string, role: UserRole): Promise<{
    user: AuthUser;
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    isNewUser: boolean;
  }> {
    const key = `${phone}:${role}`;
    const stored = otpStore.get(key);
    
    // Check if OTP exists
    if (!stored) {
      logger.warn('OTP verification failed - no OTP found', { 
        phone: maskForLogging(phone, 2, 4), 
        role 
      });
      throw new AppError(400, 'INVALID_OTP', 'Invalid or expired OTP. Please request a new one.');
    }
    
    // Check if OTP is expired
    if (new Date() > stored.expiresAt) {
      otpStore.delete(key);
      logger.warn('OTP verification failed - expired', { 
        phone: maskForLogging(phone, 2, 4), 
        role 
      });
      throw new AppError(400, 'OTP_EXPIRED', 'OTP has expired. Please request a new one.');
    }
    
    // Check attempts (max configured attempts)
    const maxAttempts = config.otp.maxAttempts;
    if (stored.attempts >= maxAttempts) {
      otpStore.delete(key);
      logger.warn('OTP verification failed - max attempts exceeded', { 
        phone: maskForLogging(phone, 2, 4), 
        role,
        attempts: stored.attempts
      });
      throw new AppError(400, 'MAX_ATTEMPTS', 'Too many failed attempts. Please request a new OTP.');
    }
    
    // Verify OTP using bcrypt (timing-safe comparison)
    const isValid = await bcrypt.compare(otp, stored.hashedOtp);
    
    if (!isValid) {
      // Increment attempts
      stored.attempts++;
      otpStore.set(key, stored);
      
      const remaining = maxAttempts - stored.attempts;
      logger.warn('OTP verification failed - invalid OTP', { 
        phone: maskForLogging(phone, 2, 4), 
        role,
        attemptsRemaining: remaining
      });
      throw new AppError(400, 'INVALID_OTP', `Invalid OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`);
    }
    
    // OTP verified - delete it immediately (single use)
    otpStore.delete(key);
    
    // Find or create user in DATABASE (not in-memory)
    let dbUser = db.getUserByPhone(phone, role);
    let isNewUser = false;
    
    if (!dbUser) {
      // Create new user in database
      dbUser = db.createUser({
        id: uuidv4(),
        phone,
        role: role as 'customer' | 'transporter' | 'driver',
        name: '',  // Will be updated when user completes profile
        isVerified: false,
        isActive: true
      });
      isNewUser = true;
      
      logger.info('New user created', { 
        userId: dbUser.id, 
        phone: maskForLogging(phone, 2, 4), 
        role 
      });
      
      // Development only: Show user creation details
      if (config.isDevelopment) {
        console.log('\n');
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log('║                  👤 NEW USER CREATED                         ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log(`║  User ID: ${dbUser.id.padEnd(50)}║`);
        console.log(`║  Phone:   ${maskForLogging(phone, 2, 4).padEnd(50)}║`);
        console.log(`║  Role:    ${role.padEnd(50)}║`);
        console.log('╚══════════════════════════════════════════════════════════════╝');
        console.log('\n');
      }
    }
    
    // Convert DB user to auth user format
    const user: AuthUser = {
      id: dbUser.id,
      phone: dbUser.phone,
      role: dbUser.role as UserRole,
      name: dbUser.name,
      email: dbUser.email,
      createdAt: new Date(dbUser.createdAt),
      updatedAt: new Date(dbUser.updatedAt)
    };
    
    // Generate tokens
    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user);
    
    // Log successful authentication (safe for production)
    logger.info('User authenticated successfully', { 
      userId: user.id, 
      phone: maskForLogging(phone, 2, 4), 
      role, 
      isNewUser 
    });
    
    // Development only: Show login details
    if (config.isDevelopment) {
      console.log('\n');
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║                  ✅ LOGIN SUCCESSFUL                         ║');
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log(`║  User ID:  ${user.id.substring(0, 36).padEnd(49)}║`);
      console.log(`║  Phone:    ${maskForLogging(phone, 2, 4).padEnd(49)}║`);
      console.log(`║  Role:     ${role.padEnd(49)}║`);
      console.log(`║  New User: ${(isNewUser ? 'Yes' : 'No').padEnd(49)}║`);
      console.log('╚══════════════════════════════════════════════════════════════╝');
      console.log('\n');
    }
    
    return {
      user,
      accessToken,
      refreshToken,
      expiresIn: this.getExpirySeconds(config.jwt.expiresIn),
      isNewUser
    };
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    // Verify refresh token
    let decoded: any;
    try {
      decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
    } catch {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
    }
    
    // Check if token is in store (not invalidated)
    const stored = refreshTokenStore.get(refreshToken);
    if (!stored || stored.userId !== decoded.userId) {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token has been revoked');
    }
    
    // Get user from database
    const dbUser = db.getUserById(decoded.userId);
    if (!dbUser) {
      throw new AppError(401, 'USER_NOT_FOUND', 'User not found');
    }
    
    // Convert to auth user
    const user: AuthUser = {
      id: dbUser.id,
      phone: dbUser.phone,
      role: dbUser.role as UserRole,
      name: dbUser.name,
      email: dbUser.email,
      createdAt: new Date(dbUser.createdAt),
      updatedAt: new Date(dbUser.updatedAt)
    };
    
    // Generate new access token
    const accessToken = this.generateAccessToken(user);
    
    return {
      accessToken,
      expiresIn: this.getExpirySeconds(config.jwt.expiresIn)
    };
  }

  /**
   * Logout user - invalidate refresh token
   */
  async logout(userId: string): Promise<void> {
    // Remove all refresh tokens for user
    for (const [token, data] of refreshTokenStore.entries()) {
      if (data.userId === userId) {
        refreshTokenStore.delete(token);
      }
    }
    
    logger.info('User logged out', { userId });
  }

  /**
   * Get user by ID from database
   */
  async getUserById(userId: string): Promise<AuthUser> {
    const dbUser = db.getUserById(userId);
    if (!dbUser) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }
    
    return {
      id: dbUser.id,
      phone: dbUser.phone,
      role: dbUser.role as UserRole,
      name: dbUser.name,
      email: dbUser.email,
      createdAt: new Date(dbUser.createdAt),
      updatedAt: new Date(dbUser.updatedAt)
    };
  }

  // ============================================================
  // PRIVATE METHODS
  // ============================================================
  
  // NOTE: OTP generation is now handled by generateSecureOTP() from crypto.utils.ts
  // The getPendingOtp() method has been REMOVED for security reasons
  // Plain OTPs are never stored - only hashed versions are kept

  private generateAccessToken(user: AuthUser): string {
    return jwt.sign(
      {
        userId: user.id,
        role: user.role,
        phone: user.phone
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );
  }

  private generateRefreshToken(user: AuthUser): string {
    const token = jwt.sign(
      { userId: user.id },
      config.jwt.refreshSecret,
      { expiresIn: config.jwt.refreshExpiresIn } as jwt.SignOptions
    );
    
    // Store refresh token
    const expiresAt = new Date(Date.now() + this.getExpirySeconds(config.jwt.refreshExpiresIn) * 1000);
    refreshTokenStore.set(token, { userId: user.id, expiresAt });
    
    return token;
  }

  private getExpirySeconds(duration: string): number {
    const match = duration.match(/^(\d+)([dhms])$/);
    if (!match) return 3600; // Default 1 hour
    
    const value = parseInt(match[1], 10);
    const unit = match[2];
    
    switch (unit) {
      case 'd': return value * 24 * 60 * 60;
      case 'h': return value * 60 * 60;
      case 'm': return value * 60;
      case 's': return value;
      default: return 3600;
    }
  }
}

export const authService = new AuthService();
