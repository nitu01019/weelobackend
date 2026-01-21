/**
 * =============================================================================
 * DRIVER AUTH MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for DRIVER authentication.
 *
 * FLOW:
 * 1. Driver enters their phone number
 * 2. System finds driver in database by phone
 * 3. System gets the transporter who owns this driver
 * 4. OTP is generated and sent to TRANSPORTER's phone
 * 5. Driver gets OTP from transporter (asks them verbally/SMS)
 * 6. Driver enters OTP and gets authenticated
 *
 * SECURITY:
 * - Cryptographically secure OTP generation (crypto.randomInt)
 * - OTPs are hashed before storage (plain OTP is NEVER stored)
 * - OTPs expire after configured time (default: 5 minutes)
 * - Maximum 3 attempts before OTP is invalidated
 * - Rate limiting enforced at route level
 * - Access tokens signed with JWT_SECRET
 * - Refresh tokens signed with JWT_REFRESH_SECRET (separate key!)
 * - OTPs logged to console ONLY in development mode
 *
 * SCALABILITY:
 * - Stateless JWT tokens (millions of concurrent users)
 * - In-memory OTP store (TODO: Replace with Redis for clustering)
 * - Async operations throughout
 *
 * FOR BACKEND DEVELOPERS:
 * - To test driver login in dev: Check server console for OTP
 * - In production: OTP is sent to transporter via SMS
 * =============================================================================
 */
/**
 * DriverAuthService - Handles driver-specific authentication
 * Separate from transporter auth for modularity and scalability
 */
declare class DriverAuthService {
    private readonly OTP_EXPIRY_MINUTES;
    private readonly MAX_OTP_ATTEMPTS;
    private readonly SALT_ROUNDS;
    /**
     * Send OTP for driver login
     *
     * @param driverPhone - The driver's phone number
     * @returns Object with masked transporter phone for UI hint
     * @throws AppError if driver not found or not associated with any transporter
     */
    sendOtp(driverPhone: string): Promise<{
        message: string;
        transporterPhoneMasked: string;
        driverId: string;
        driverName: string;
    }>;
    /**
     * Verify OTP and authenticate driver
     *
     * @param driverPhone - Driver's phone number
     * @param otp - OTP received from transporter
     * @returns JWT tokens and driver data
     */
    verifyOtp(driverPhone: string, otp: string): Promise<{
        accessToken: string;
        refreshToken: string;
        driver: {
            id: string;
            name: string;
            phone: string;
            transporterId: string;
            transporterName: string;
            licenseNumber?: string;
            profilePhoto?: string;
        };
    }>;
    /**
     * Find driver by phone number in database
     */
    private findDriverByPhone;
    /**
     * Find transporter by ID
     */
    private findTransporterById;
    /**
     * Mask phone number for privacy (78****631)
     */
    private maskPhone;
    /**
     * Generate JWT access token for driver
     * Uses JWT_SECRET for signing
     */
    private generateAccessToken;
    /**
     * Generate JWT refresh token for driver
     *
     * SECURITY: Uses JWT_REFRESH_SECRET (separate from access token secret)
     * This ensures that even if access token secret is compromised,
     * refresh tokens remain secure.
     */
    private generateRefreshToken;
}
export declare const driverAuthService: DriverAuthService;
export {};
//# sourceMappingURL=driver-auth.service.d.ts.map