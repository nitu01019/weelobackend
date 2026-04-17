/**
 * =============================================================================
 * ORDER IDEMPOTENCY SERVICE - DB-level idempotency helpers
 * =============================================================================
 *
 * Extracted from order-creation.service.ts during file-size decomposition.
 * Contains DB idempotency lookup and persistence helpers.
 * =============================================================================
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { truncate } from '../../shared/utils/truncate';
import { AppError } from '../../shared/types/error.types';
import type { CreateOrderResponse } from './order-core-types';
import { FF_DB_STRICT_IDEMPOTENCY } from './order-core-types';

/**
 * F-A-02: Constant-time payload-hash fingerprint comparison.
 *
 * Follows IETF draft-ietf-httpapi-idempotency-key-header-07 §2: a stored
 * idempotency record carries a fingerprint of the original payload, and a
 * mismatching fingerprint is treated as a conflict rather than a silent
 * replay. Using `crypto.timingSafeEqual` avoids leaking timing signal about
 * the stored hash back to an attacker probing the endpoint.
 */
function payloadHashesMatch(stored: string, incoming: string): boolean {
  const storedBuf = Buffer.from(stored, 'utf8');
  const incomingBuf = Buffer.from(incoming, 'utf8');
  if (storedBuf.length !== incomingBuf.length) return false;
  return crypto.timingSafeEqual(storedBuf, incomingBuf);
}

/**
 * Get an idempotent response from the database.
 */
export async function getDbIdempotentResponse(
  customerId: string,
  idempotencyKey: string,
  payloadHash: string
): Promise<CreateOrderResponse | null> {
  const row = await prismaClient.orderIdempotency.findUnique({
    where: { customerId_idempotencyKey: { customerId, idempotencyKey } }
  });
  if (!row) return null;
  if (!payloadHashesMatch(row.payloadHash, payloadHash)) {
    if (!FF_DB_STRICT_IDEMPOTENCY) {
      logger.warn('Idempotency key reused with different payload while strict mode is disabled', {
        customerId,
        idempotencyKey: truncate(idempotencyKey, 11)
      });
      return null;
    }
    // F-A-02: per Stripe + IETF draft §2, same key + different payload is a
    // conflict, NOT a silent replay. 409 is the response Stripe returns on
    // `idempotency_key_in_use` with a mismatched request body.
    throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different payload');
  }
  return row.responseJson as unknown as CreateOrderResponse;
}

/**
 * Persist an idempotent response to the database.
 */
export async function persistDbIdempotentResponse(
  customerId: string,
  idempotencyKey: string,
  payloadHash: string,
  orderId: string,
  response: CreateOrderResponse
): Promise<void> {
  try {
    await prismaClient.orderIdempotency.create({
      data: {
        id: uuidv4(),
        customerId,
        idempotencyKey,
        payloadHash,
        orderId,
        responseJson: response as unknown as Prisma.InputJsonValue
      }
    });
  } catch (error: unknown) {
    const prismaError = error as { code?: string };
    if (prismaError?.code !== 'P2002') {
      throw error;
    }
    const existing = await getDbIdempotentResponse(customerId, idempotencyKey, payloadHash);
    if (!existing) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key conflict');
    }
  }
}
