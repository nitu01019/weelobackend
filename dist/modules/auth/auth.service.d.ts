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
import { UserRole } from '../../shared/types/api.types';
interface AuthUser {
    id: string;
    phone: string;
    role: UserRole;
    name?: string;
    email?: string;
    createdAt: Date;
    updatedAt: Date;
}
declare class AuthService {
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
    sendOtp(phone: string, role: UserRole): Promise<{
        expiresIn: number;
        message: string;
    }>;
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
    verifyOtp(phone: string, otp: string, role: UserRole): Promise<{
        user: AuthUser;
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        isNewUser: boolean;
    }>;
    /**
     * Refresh access token
     */
    refreshToken(refreshToken: string): Promise<{
        accessToken: string;
        expiresIn: number;
    }>;
    /**
     * Logout user - invalidate refresh token
     */
    logout(userId: string): Promise<void>;
    /**
     * Get user by ID from database
     */
    getUserById(userId: string): Promise<AuthUser>;
    private generateAccessToken;
    private generateRefreshToken;
    private getExpirySeconds;
}
export declare const authService: AuthService;
export {};
//# sourceMappingURL=auth.service.d.ts.map