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

import { config } from '../../config/environment';
import { logger } from '../../shared/services/logger.service';
import { AppError } from '../../shared/types/error.types';

interface SmsProvider {
  sendOtp(phone: string, otp: string): Promise<void>;
}

/**
 * Twilio SMS Provider
 */
class TwilioProvider implements SmsProvider {
  async sendOtp(phone: string, otp: string): Promise<void> {
    const { accountSid, authToken, phoneNumber } = config.sms.twilio;
    
    if (!accountSid || !authToken || !phoneNumber) {
      throw new AppError(500, 'SMS_CONFIG_ERROR', 'Twilio configuration is incomplete');
    }
    
    // Format phone number for international format
    const formattedPhone = phone.startsWith('+') ? phone : `+91${phone}`;
    
    try {
      // Dynamic import to avoid loading Twilio if not used
      const twilio = require('twilio');
      const client = twilio(accountSid, authToken);
      
      await client.messages.create({
        body: `Your Weelo verification code is: ${otp}. Valid for ${config.otp.expiryMinutes} minutes.`,
        from: phoneNumber,
        to: formattedPhone
      });
      
      logger.info('SMS sent via Twilio', { phone: phone.slice(-4) });
    } catch (error: any) {
      logger.error('Twilio SMS failed', { error: error.message });
      throw new AppError(500, 'SMS_SEND_FAILED', 'Failed to send OTP. Please try again.');
    }
  }
}

/**
 * MSG91 SMS Provider (India)
 */
class MSG91Provider implements SmsProvider {
  async sendOtp(phone: string, otp: string): Promise<void> {
    const { authKey, senderId, templateId } = config.sms.msg91;
    
    if (!authKey || !templateId) {
      throw new AppError(500, 'SMS_CONFIG_ERROR', 'MSG91 configuration is incomplete');
    }
    
    try {
      const response = await fetch('https://api.msg91.com/api/v5/otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authkey': authKey
        },
        body: JSON.stringify({
          template_id: templateId,
          mobile: `91${phone}`,
          otp: otp,
          sender: senderId
        })
      });
      
      if (!response.ok) {
        throw new Error(`MSG91 API error: ${response.status}`);
      }
      
      logger.info('SMS sent via MSG91', { phone: phone.slice(-4) });
    } catch (error: any) {
      logger.error('MSG91 SMS failed', { error: error.message });
      throw new AppError(500, 'SMS_SEND_FAILED', 'Failed to send OTP. Please try again.');
    }
  }
}

/**
 * Console SMS Provider (for development - logs OTP to console)
 * OTP is already logged in auth.service.ts with nice formatting
 * This provider just allows the flow to complete without sending real SMS
 */
class ConsoleProvider implements SmsProvider {
  async sendOtp(phone: string, _otp: string): Promise<void> {
    // OTP is already logged in auth.service.ts with nice formatting
    // This provider does nothing extra - just allows the flow to complete
    // The _otp parameter is intentionally unused (prefixed with _)
    logger.info(`OTP ready for phone: ${phone.slice(-4)}`);
  }
}

/**
 * SMS Service - uses configured provider
 * In development: OTPs are logged to console
 * In production: Configure Twilio or MSG91 to send real SMS
 */
class SmsService {
  private provider: SmsProvider;
  
  constructor() {
    const { provider, twilio, msg91 } = config.sms;
    
    // Check if Twilio is configured
    if (provider === 'twilio' && twilio.accountSid && twilio.authToken && twilio.phoneNumber) {
      this.provider = new TwilioProvider();
      logger.info('SMS Service initialized with Twilio provider');
    }
    // Check if MSG91 is configured
    else if (provider === 'msg91' && msg91.authKey && msg91.templateId) {
      this.provider = new MSG91Provider();
      logger.info('SMS Service initialized with MSG91 provider');
    }
    // Default: Console logging (development)
    else {
      this.provider = new ConsoleProvider();
      logger.info('SMS Service: OTPs will be logged to console (configure SMS provider for production)');
    }
  }
  
  /**
   * Send OTP via SMS
   */
  async sendOtp(phone: string, otp: string): Promise<void> {
    await this.provider.sendOtp(phone, otp);
  }
}

export const smsService = new SmsService();
