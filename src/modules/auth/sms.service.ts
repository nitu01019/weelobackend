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
import { metrics } from '../../shared/monitoring/metrics.service';

interface SmsProvider {
  sendOtp(phone: string, otp: string): Promise<void>;
}

/**
 * Twilio SMS Provider
 */
class TwilioProvider implements SmsProvider {
  private client: any | null = null;

  private getClient() {
    if (this.client) return this.client;
    const { accountSid, authToken } = config.sms.twilio;
    const twilio = require('twilio');
    this.client = twilio(accountSid, authToken);
    return this.client;
  }

  async sendOtp(phone: string, otp: string): Promise<void> {
    const { accountSid, authToken, phoneNumber } = config.sms.twilio;
    
    if (!accountSid || !authToken || !phoneNumber) {
      throw new AppError(500, 'SMS_CONFIG_ERROR', 'Twilio configuration is incomplete');
    }
    
    // Format phone number for international format
    const formattedPhone = phone.startsWith('+') ? phone : `+91${phone}`;
    
    try {
      const client = this.getClient();
      
      // SMS Retriever API format: <#> prefix + app hash suffix
      const appHash = config.sms.retrieverHash || process.env.SMS_RETRIEVER_HASH || '';
      const hashSuffix = appHash ? `\n${appHash}` : '';
      await client.messages.create({
        body: `<#> Your Weelo verification code is: ${otp}. Valid for ${config.otp.expiryMinutes} minutes.${hashSuffix}`,
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
  private client: any | null = null;

  private getClient() {
    if (this.client) return this.client;
    const { region, accessKeyId, secretAccessKey } = config.sms.awsSns;
    const { SNSClient } = require('@aws-sdk/client-sns');
    const clientConfig: any = { region };

    if (accessKeyId && secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId,
        secretAccessKey
      };
    }

    this.client = new SNSClient(clientConfig);
    return this.client;
  }

  async sendOtp(phone: string, otp: string): Promise<void> {
    const { region, accessKeyId, secretAccessKey } = config.sms.awsSns;
    
    if (!region) {
      throw new AppError(500, 'SMS_CONFIG_ERROR', 'AWS SNS region is not configured');
    }
    
    // Format phone number for international format (India)
    const formattedPhone = phone.startsWith('+') ? phone : `+91${phone}`;
    
    try {
      // Dynamic import to avoid loading AWS SDK if not used
      const { PublishCommand } = require('@aws-sdk/client-sns');
      const client = this.getClient();
      
      // SMS Retriever API format: Must start with <#> and end with app hash
      // The app hash is computed from the signing certificate + package name
      // This enables zero-permission OTP auto-read on Android
      // App hash is logged by AppSignatureHelper.kt on first run — update SMS_RETRIEVER_HASH env var
      const appHash = config.sms.retrieverHash || process.env.SMS_RETRIEVER_HASH || '';
      const hashSuffix = appHash ? `\n${appHash}` : '';
      const message = `<#> Your Weelo verification code is: ${otp}. Valid for ${config.otp.expiryMinutes} minutes.${hashSuffix}`;
      
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
    if (!config.isDevelopment) {
      throw new AppError(500, 'SMS_PROVIDER_DISABLED', 'Console SMS provider is disabled outside development');
    }
    logger.info('[SMS] OTP sent via console provider', {
      phoneLast4: phone.slice(-4),
      otpGenerated: true,
      expiryMinutes: config.otp.expiryMinutes
    });
  }
}

/**
 * SMS Service - uses configured provider with retry logic and automatic fallback
 *
 * SCALABILITY:
 * - Primary provider handles millions of SMS via AWS SNS / Twilio / MSG91
 * - Retry logic: up to 2 attempts with exponential back-off before giving up
 * - Secondary real provider fallback (if configured) before console fallback
 * - OTP is always retrievable from CloudWatch logs on failure
 * - Non-blocking: SMS failure does NOT block OTP storage
 *
 * MODULARITY:
 * - Each provider is independent and interchangeable
 * - Fallback chain: Primary (with retries) → Secondary (with retries) → Console (dev only)
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
  private secondaryProvider: SmsProvider | null = null;
  private fallbackProvider: ConsoleProvider;
  private providerName: string;
  private secondaryProviderName: string | null = null;

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
      // Wire MSG91 as secondary if also configured
      if (msg91.authKey && msg91.templateId) {
        this.secondaryProvider = new MSG91Provider();
        this.secondaryProviderName = 'MSG91';
        logger.info('SMS Service: MSG91 configured as secondary provider');
      }
    }
    // Check if Twilio is configured
    else if (provider === 'twilio' && twilio.accountSid && twilio.authToken && twilio.phoneNumber) {
      this.provider = new TwilioProvider();
      this.providerName = 'Twilio';
      logger.info('SMS Service initialized with Twilio provider');
      // Wire MSG91 as secondary if also configured
      if (msg91.authKey && msg91.templateId) {
        this.secondaryProvider = new MSG91Provider();
        this.secondaryProviderName = 'MSG91';
        logger.info('SMS Service: MSG91 configured as secondary provider');
      }
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
   * Attempt sendFn up to maxRetries times with exponential back-off.
   * Logs a warn on each failed attempt and returns true on first success.
   * Returns false if all attempts are exhausted without success.
   */
  private async sendWithRetry(
    sendFn: () => Promise<void>,
    providerName: string,
    phone: string,
    maxRetries: number = 2,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await sendFn();
        return true;
      } catch (error) {
        logger.warn(`SMS ${providerName} attempt ${attempt}/${maxRetries} failed`, {
          phone: phone.slice(-4),
          error: (error as Error).message,
          attempt,
        });
        if (attempt < maxRetries) {
          // 1-second delay before attempt 2, 2-second before attempt 3, etc.
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    return false;
  }

  /**
   * Send OTP via SMS with retry logic and automatic fallback
   *
   * SCALABILITY: Non-blocking, handles provider failures gracefully
   * EASY UNDERSTANDING: Try primary (with retries) → secondary (with retries) → console (dev)
   * MODULARITY: Provider-agnostic, same interface for all
   * CODING STANDARDS: Detailed error logging for debugging
   */
  async sendOtp(phone: string, otp: string): Promise<void> {
    if (config.isProduction && this.provider === this.fallbackProvider) {
      throw new AppError(500, 'SMS_PROVIDER_DISABLED', 'No production SMS provider is configured');
    }

    // --- Primary provider with retries ---
    const primarySent = await this.sendWithRetry(
      () => this.provider.sendOtp(phone, otp),
      this.providerName,
      phone,
    );

    if (primarySent) {
      this.metrics.sent++;
      metrics.incrementCounter('sms_delivery_total', { status: 'success', provider: this.providerName });
      return;
    }

    // --- Secondary real provider with retries (if configured) ---
    if (this.secondaryProvider && this.secondaryProviderName) {
      logger.warn(`SMS primary provider (${this.providerName}) exhausted retries — trying secondary (${this.secondaryProviderName})`, {
        phone: phone.slice(-4),
      });

      const secondarySent = await this.sendWithRetry(
        () => this.secondaryProvider!.sendOtp(phone, otp),
        this.secondaryProviderName,
        phone,
      );

      if (secondarySent) {
        this.metrics.sent++;
        this.metrics.fallbackUsed++;
        metrics.incrementCounter('sms_delivery_total', { status: 'success', provider: this.secondaryProviderName });
        return;
      }

      // Both providers failed
      this.metrics.failed++;
      this.metrics.lastFailure = `Both ${this.providerName} and ${this.secondaryProviderName} failed`;
      this.metrics.lastFailureTime = new Date();
      metrics.incrementCounter('sms_delivery_total', {
        status: 'failure',
        provider: 'all',
        reason: 'ALL_PROVIDERS_FAILED',
      });
      logger.error('SMS delivery failed on ALL providers', {
        phone: phone.slice(-4),
        primaryProvider: this.providerName,
        secondaryProvider: this.secondaryProviderName,
      });

      // Development only: last-resort console fallback
      if (config.isDevelopment) {
        logger.warn('Falling back to console logging for OTP delivery (dev only)');
        try {
          await this.fallbackProvider.sendOtp(phone, otp);
          this.metrics.fallbackUsed++;
          metrics.incrementCounter('sms_delivery_total', { status: 'fallback', provider: 'console' });
          return;
        } catch (fallbackError: any) {
          logger.error('Console fallback also failed', { error: fallbackError.message });
        }
      }

      throw new AppError(503, 'SMS_DELIVERY_FAILED', 'Unable to send SMS. Please try again.');
    }

    // --- No secondary provider: primary failed all retries ---
    this.metrics.failed++;
    this.metrics.lastFailure = `${this.providerName} failed all retries`;
    this.metrics.lastFailureTime = new Date();
    metrics.incrementCounter('sms_delivery_total', {
      status: 'failure',
      provider: this.providerName,
      reason: 'RETRIES_EXHAUSTED',
    });
    logger.error(`SMS delivery failed via ${this.providerName} after all retries`, {
      phone: phone.slice(-4),
      provider: this.providerName,
      totalFailures: this.metrics.failed,
    });

    // Development only: fallback to console logging for local dev debugging.
    if (config.isDevelopment && this.provider !== this.fallbackProvider) {
      logger.warn('Falling back to console logging for OTP delivery (dev only)');
      try {
        await this.fallbackProvider.sendOtp(phone, otp);
        this.metrics.fallbackUsed++;
        metrics.incrementCounter('sms_delivery_total', { status: 'fallback', provider: 'console' });
        return;
      } catch (fallbackError: any) {
        logger.error('Console fallback also failed', { error: fallbackError.message });
      }
    }

    throw new AppError(503, 'SMS_DELIVERY_FAILED', 'Unable to send SMS. Please try again.');
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
