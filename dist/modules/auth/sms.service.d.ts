/**
 * =============================================================================
 * SMS SERVICE
 * =============================================================================
 *
 * Handles sending SMS messages via configured provider.
 * Supports: Twilio, MSG91 (India)
 *
 * SECURITY:
 * - API keys stored in environment variables only
 * - Phone numbers are validated before sending
 * - Rate limiting is enforced at route level
 * =============================================================================
 */
/**
 * SMS Service - uses configured provider
 * In development: OTPs are logged to console
 * In production: Configure Twilio or MSG91 to send real SMS
 */
declare class SmsService {
    private provider;
    constructor();
    /**
     * Send OTP via SMS
     */
    sendOtp(phone: string, otp: string): Promise<void>;
}
export declare const smsService: SmsService;
export {};
//# sourceMappingURL=sms.service.d.ts.map