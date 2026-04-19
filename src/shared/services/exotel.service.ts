/**
 * =============================================================================
 * EXOTEL MASKED CALLING SERVICE
 * =============================================================================
 *
 * Provides masked (anonymous) calling between drivers and customers via Exotel.
 * Neither party sees the other's real phone number.
 *
 * FEATURE FLAG: FF_MASKED_CALLING=true to enable
 *
 * SECURITY:
 * - Credentials from environment variables only
 * - Phone numbers never logged
 * - CallType='trans' for transactional calls
 * =============================================================================
 */

import { logger } from './logger.service';

/** Timeout for Exotel HTTP requests (ms). Prevents indefinite hangs. */
const EXOTEL_REQUEST_TIMEOUT_MS = 15_000;

interface ExotelConfig {
  apiKey: string;
  apiToken: string;
  subdomain: string;
  callerId: string;
  enabled: boolean;
}

interface CallResult {
  success: boolean;
  callSid?: string;
  error?: string;
}

class ExotelService {
  private readonly config: ExotelConfig;

  constructor() {
    this.config = {
      apiKey: process.env.EXOTEL_API_KEY || '',
      apiToken: process.env.EXOTEL_API_TOKEN || '',
      subdomain: process.env.EXOTEL_SUBDOMAIN || '',
      callerId: process.env.EXOTEL_CALLER_ID || '',
      enabled: process.env.FF_MASKED_CALLING === 'true',
    };
  }

  isConfigured(): boolean {
    return (
      this.config.enabled &&
      !!(this.config.apiKey && this.config.apiToken && this.config.subdomain && this.config.callerId)
    );
  }

  async initiateCall(fromPhone: string, toPhone: string): Promise<CallResult> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Exotel not configured' };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXOTEL_REQUEST_TIMEOUT_MS);

    try {
      const url = `https://${this.config.apiKey}:${this.config.apiToken}@${this.config.subdomain}.exotel.com/v1/Accounts/${this.config.apiKey}/Calls/connect.json`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal,
        body: new URLSearchParams({
          From: fromPhone,
          To: toPhone,
          CallerId: this.config.callerId,
          CallType: 'trans',
          StatusCallback: process.env.EXOTEL_CALLBACK_URL || '',
        }),
      });

      if (!response.ok) {
        logger.error('Exotel call failed', { status: response.status });
        return { success: false, error: 'Call initiation failed' };
      }

      const data = (await response.json()) as Record<string, unknown>;
      const callData = data?.Call as Record<string, unknown> | undefined;
      const sid = typeof callData?.Sid === 'string' ? callData.Sid : undefined;
      return { success: true, callSid: sid };
    } catch (error: unknown) {
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      logger.error('Exotel error', {
        error: error instanceof Error ? error.message : String(error),
        timeout: isTimeout,
      });
      return {
        success: false,
        error: isTimeout ? `Call service timed out after ${EXOTEL_REQUEST_TIMEOUT_MS}ms` : 'Call service unavailable',
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export const exotelService = new ExotelService();
