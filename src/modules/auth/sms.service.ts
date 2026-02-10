/**
 * =============================================================================
 * SMS SERVICE
 * =============================================================================
 * 
 * Handles sending SMS messages via configured provider.
 * Supports: Twilio, MSG91 (India), AWS SNS
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
 * AWS SNS SMS Provider (India - Cost Effective)
 * Uses AWS Simple Notification Service for sending SMS
 */
class AWSSNSProvider implements SmsProvider {
  async sendOtp(phone: string, otp: string): Promise<void> {
    const { region, accessKeyId, secretAccessKey } = config.sms.awsSns;
    
    if (!region) {
      throw new AppError(500, 'SMS_CONFIG_ERROR', 'AWS SNS region is not configured');
    }
    
    // Format phone number for international format (India)
    const formattedPhone = phone.startsWith('+') ? phone : `+91${phone}`;
    
    try {
      // Dynamic import to avoid loading AWS SDK if not used
      const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
      
      // Create SNS client - uses IAM role if on AWS, or env credentials
      const clientConfig: any = { region };
      
      // Only add credentials if explicitly provided (for local development)
      // On AWS ECS/EC2, IAM role is used automatically
      if (accessKeyId && secretAccessKey) {
        clientConfig.credentials = {
          accessKeyId,
          secretAccessKey
        };
      }
      
      const client = new SNSClient(clientConfig);
      
      const message = `Your Weelo verification code is: ${otp}. Valid for ${config.otp.expiryMinutes} minutes. Do not share this code.`;
      
      const command = new PublishCommand({
        PhoneNumber: formattedPhone,
        Message: message,
        MessageAttributes: {
          'AWS.SNS.SMS.SenderID': {
            DataType: 'String',
            StringValue: 'WEELO'
          },
          'AWS.SNS.SMS.SMSType': {
            DataType: 'String',
            StringValue: 'Transactional'
          }
        }
      });
      
      await client.send(command);
      
      logger.info('SMS sent via AWS SNS', { phone: phone.slice(-4) });
    } catch (error: any) {
      logger.error('AWS SNS SMS failed', { error: error.message });
      throw new AppError(500, 'SMS_SEND_FAILED', 'Failed to send OTP. Please try again.');
    }
  }
}

/**
 * Console SMS Provider (DEVELOPMENT ONLY)
 * Logs OTP to console instead of sending SMS
 */
class ConsoleProvider implements SmsProvider {
  async sendOtp(phone: string, otp: string): Promise<void> {
    console.log('\n===========================================');
    console.log('📱 SMS (CONSOLE MODE - DEV ONLY)');
    console.log('===========================================');
    console.log(`Phone: ${phone}`);
    console.log(`OTP: ${otp}`);
    console.log(`Valid for: ${config.otp.expiryMinutes} minutes`);
    console.log('===========================================\n');
    
    logger.warn('SMS sent via CONSOLE (development mode)', { 
      phone: phone.slice(-4),
      otp 
    });
  }
}

/**
 * SMS Service - uses configured provider with automatic fallback
 * 
 * SCALABILITY:
 * - Primary provider handles millions of SMS via AWS SNS / Twilio / MSG91
 * - Automatic fallback to console logging if primary provider fails
 * - OTP is always retrievable from CloudWatch logs on failure
 * - Non-blocking: SMS failure does NOT block OTP storage
 * 
 * MODULARITY:
 * - Each provider is independent and interchangeable
 * - Fallback chain: Primary → Console (OTP visible in logs)
 * 
 * CODING STANDARDS:
 * - Detailed error logging with provider name and error code
 * - Metrics tracking for SMS delivery success/failure rates
 * 
 * EASY UNDERSTANDING:
 * - Single sendOtp() method handles all complexity internally
 * - Caller never needs to know which provider is used
 */
class SmsService {
  private provider: SmsProvider;
  private fallbackProvider: ConsoleProvider;
  private providerName: string;
  
  // SCALABILITY: Track SMS delivery metrics for monitoring
  private metrics = {
    sent: 0,
    failed: 0,
    fallbackUsed: 0,
    lastFailure: null as string | null,
    lastFailureTime: null as Date | null,
  };
  
  constructor() {
    const { provider, twilio, msg91, awsSns } = config.sms;
    
    // Always create a console fallback provider
    this.fallbackProvider = new ConsoleProvider();
    
    // Check if AWS SNS is configured (recommended for AWS deployments)
    if (provider === 'aws-sns' && awsSns.region) {
      this.provider = new AWSSNSProvider();
      this.providerName = 'AWS SNS';
      logger.info('SMS Service initialized with AWS SNS provider');
    }
    // Check if Twilio is configured
    else if (provider === 'twilio' && twilio.accountSid && twilio.authToken && twilio.phoneNumber) {
      this.provider = new TwilioProvider();
      this.providerName = 'Twilio';
      logger.info('SMS Service initialized with Twilio provider');
    }
    // Check if MSG91 is configured
    else if (provider === 'msg91' && msg91.authKey && msg91.templateId) {
      this.provider = new MSG91Provider();
      this.providerName = 'MSG91';
      logger.info('SMS Service initialized with MSG91 provider');
    }
    // FALLBACK to console for development
    else {
      this.provider = this.fallbackProvider;
      this.providerName = 'Console';
      logger.warn('⚠️  SMS Service: Using CONSOLE mode (development only). Configure AWS SNS/Twilio/MSG91 for production.');
    }
  }
  
  /**
   * Send OTP via SMS with automatic fallback
   * 
   * SCALABILITY: Non-blocking, handles provider failures gracefully
   * EASY UNDERSTANDING: Try primary → fallback to console on failure
   * MODULARITY: Provider-agnostic, same interface for all
   * CODING STANDARDS: Detailed error logging for debugging
   */
  async sendOtp(phone: string, otp: string): Promise<void> {
    try {
      await this.provider.sendOtp(phone, otp);
      this.metrics.sent++;
    } catch (error: any) {
      this.metrics.failed++;
      this.metrics.lastFailure = error.message;
      this.metrics.lastFailureTime = new Date();
      
      logger.error(`❌ SMS delivery failed via ${this.providerName}`, {
        error: error.message,
        errorCode: error.code || 'UNKNOWN',
        phone: phone.slice(-4),
        provider: this.providerName,
        totalFailures: this.metrics.failed,
      });
      
      // AUTOMATIC FALLBACK: Log OTP to console/CloudWatch so it's retrievable
      // This ensures the user can still get their OTP even if SMS provider is down
      if (this.provider !== this.fallbackProvider) {
        logger.warn(`⚠️  Falling back to console logging for OTP delivery`);
        try {
          await this.fallbackProvider.sendOtp(phone, otp);
          this.metrics.fallbackUsed++;
        } catch (fallbackError: any) {
          logger.error('Console fallback also failed', { error: fallbackError.message });
        }
      }
      
      // Re-throw so caller knows SMS failed (they can decide to continue or not)
      throw error;
    }
  }
  
  /**
   * Get SMS delivery metrics for monitoring
   * SCALABILITY: Used by health check endpoint for production monitoring
   */
  getMetrics() {
    return {
      provider: this.providerName,
      ...this.metrics,
      successRate: this.metrics.sent + this.metrics.failed > 0
        ? ((this.metrics.sent / (this.metrics.sent + this.metrics.failed)) * 100).toFixed(1) + '%'
        : 'N/A',
    };
  }
}

export const smsService = new SmsService();
