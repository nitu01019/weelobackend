/**
 * =============================================================================
 * USER REPOSITORY — User CRUD operations
 * =============================================================================
 */

import { UserRole } from '@prisma/client';
import { getPrismaClient, sanitizeDbError } from '../prisma-client';
import { toUserRecord } from '../record-helpers';
import type { UserRecord } from '../record-types';
import { logger } from '../../services/logger.service';

export async function createUser(user: Omit<UserRecord, 'createdAt' | 'updatedAt'>): Promise<UserRecord> {
  const prisma = getPrismaClient();
  const existing = await prisma.user.findFirst({
    where: { phone: user.phone, role: user.role as UserRole }
  });

  if (existing) {
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: {
        ...user,
        role: user.role as UserRole,
      }
    });
    return toUserRecord(updated);
  }

  const created = await prisma.user.create({
    data: {
      ...user,
      role: user.role as UserRole,
    }
  });
  return toUserRecord(created);
}

export async function getUserById(id: string): Promise<UserRecord | undefined> {
  const prisma = getPrismaClient();
  // Redis cache-aside
  try {
    const { redisService } = require('../../services/redis.service');
    const cacheKey = `user:profile:${id}`;
    const cached = await redisService.get(cacheKey);
    if (cached) {
      const { safeJsonParse } = require('../../utils/safe-json.utils');
      const parsed = safeJsonParse(cached, null, 'user-profile-cache');
      if (parsed) return parsed;
    }
  } catch (error) {
    logger.warn('User profile cache read failed', { error: error instanceof Error ? error.message : String(error) });
  }

  const user = await prisma.user.findUnique({ where: { id } });
  const record = user ? toUserRecord(user) : undefined;

  if (record) {
    try {
      const { redisService } = require('../../services/redis.service');
      redisService.set(`user:profile:${id}`, JSON.stringify(record), 60).catch(() => {});
    } catch (error) {
      logger.warn('User profile cache write failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return record;
}

export async function getUserByPhone(phone: string, role: string): Promise<UserRecord | undefined> {
  const prisma = getPrismaClient();
  const user = await prisma.user.findFirst({
    where: { phone, role: role as UserRole }
  });
  return user ? toUserRecord(user) : undefined;
}

export async function getDriversByTransporter(transporterId: string): Promise<UserRecord[]> {
  const prisma = getPrismaClient();
  const drivers = await prisma.user.findMany({
    where: { role: 'driver', transporterId }
  });
  return drivers.map(d => toUserRecord(d));
}

export async function updateUser(id: string, updates: Partial<UserRecord>): Promise<UserRecord | undefined> {
  const prisma = getPrismaClient();
  try {
    const { createdAt: _ca, updatedAt: _ua, ...data } = updates as Partial<UserRecord> & { createdAt?: unknown; updatedAt?: unknown };
    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...data,
        role: data.role ? data.role as UserRole : undefined,
      }
    });

    try {
      const { redisService } = require('../../services/redis.service');
      await redisService.del(`user:profile:${id}`);
    } catch (error) {
      logger.warn('User profile cache invalidation failed', { error: error instanceof Error ? error.message : String(error) });
    }

    return toUserRecord(updated);
  } catch (error) {
    logger.error('DB operation failed', { error: error instanceof Error ? sanitizeDbError(error.message) : String(error) });
    return undefined;
  }
}
