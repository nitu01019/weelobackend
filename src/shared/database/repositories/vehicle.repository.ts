/**
 * =============================================================================
 * VEHICLE REPOSITORY — Vehicle CRUD + transporter queries
 * =============================================================================
 */

import { VehicleStatus, Vehicle } from '@prisma/client';
import { getPrismaClient, sanitizeDbError } from '../prisma-client';
import { toVehicleRecord, normalizeVehicleString, vehicleStringsMatch } from '../record-helpers';
import type { VehicleRecord } from '../record-types';
import { logger } from '../../services/logger.service';
import { generateVehicleKey, generateVehicleKeyCandidates } from '../../services/vehicle-key.service';
import { redisService } from '../../services/redis.service';
import { onVehicleTransition } from '../../services/vehicle-lifecycle.service';
import { liveAvailabilityService } from '../../services/live-availability.service';

function vehiclesCacheKey(transporterId: string): string {
  return `cache:vehicles:transporter:${transporterId}`;
}

export async function createVehicle(vehicle: Omit<VehicleRecord, 'createdAt' | 'updatedAt'>): Promise<VehicleRecord> {
  const prisma = getPrismaClient();

  // #111 FIX: Replace check-then-create (race condition) with upsert + P2002 catch.
  // Two concurrent requests for the same vehicleNumber no longer risk a duplicate-key error
  // or silently creating two rows. The upsert is atomic at the DB level.
  let result: Vehicle;
  let isNew = false;
  try {
    // Attempt upsert: create if not exists, otherwise touch updatedAt only
    // (preserve existing status/fields on conflict — caller can call updateVehicle if full update is needed).
    result = await prisma.vehicle.upsert({
      where: { vehicleNumber: vehicle.vehicleNumber },
      create: {
        ...vehicle,
        status: vehicle.status as VehicleStatus,
      },
      update: {
        updatedAt: new Date(),
      },
    });
    // Determine if this was a create or update by checking createdAt ≈ updatedAt
    isNew = Math.abs(result.createdAt.getTime() - result.updatedAt.getTime()) < 1000;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      // Concurrent insert race — safe to fetch the winner
      const found = await prisma.vehicle.findUnique({
        where: { vehicleNumber: vehicle.vehicleNumber }
      });
      if (!found) throw err;
      result = found;
      isNew = false;
    } else {
      throw err;
    }
  }

  // #112: Log cache invalidation failures instead of silently swallowing
  redisService.del(vehiclesCacheKey(vehicle.transporterId)).catch(err => {
    logger.warn('[VehicleRepo] Cache invalidation failed', { error: err?.message || String(err) });
  });

  if (isNew) {
    logger.info(`Vehicle registered: ${vehicle.vehicleNumber} (${vehicle.vehicleType})`);
    if (!vehicle.status || vehicle.status === 'available') {
      liveAvailabilityService.onVehicleCreated(vehicle.transporterId, vehicle.vehicleKey || '')
        .catch(err => logger.warn('[LiveAvail] createVehicle hook failed:', (err as Error).message));
    }
  } else {
    logger.info(`Vehicle upserted (already existed): ${vehicle.vehicleNumber} (${vehicle.vehicleType})`);
    if (result.transporterId && result.transporterId !== vehicle.transporterId) {
      redisService.del(vehiclesCacheKey(result.transporterId)).catch(err => {
        logger.warn('[VehicleRepo] Cache invalidation failed', { error: err?.message || String(err) });
      });
    }
  }

  return toVehicleRecord(result);
}

export async function getVehicleById(id: string): Promise<VehicleRecord | undefined> {
  const prisma = getPrismaClient();
  const vehicle = await prisma.vehicle.findUnique({ where: { id } });
  return vehicle ? toVehicleRecord(vehicle) : undefined;
}

export async function getVehicleByNumber(vehicleNumber: string): Promise<VehicleRecord | undefined> {
  const prisma = getPrismaClient();
  const vehicle = await prisma.vehicle.findUnique({ where: { vehicleNumber } });
  return vehicle ? toVehicleRecord(vehicle) : undefined;
}

export async function getVehiclesByTransporter(transporterId: string): Promise<VehicleRecord[]> {
  const prisma = getPrismaClient();
  const cacheKey = vehiclesCacheKey(transporterId);

  try {
    const cached = await redisService.get(cacheKey);
    if (cached) {
      const { safeJsonParse } = require('../../utils/safe-json.utils');
      const parsed = safeJsonParse(cached, null, 'vehicle-cache') as VehicleRecord[] | null;
      if (parsed) return parsed;
    }
  } catch (error) {
    logger.warn('Vehicle cache read failed', { error: error instanceof Error ? error.message : String(error) });
  }

  const vehicles = await prisma.vehicle.findMany({ where: { transporterId } });
  const records = vehicles.map(v => toVehicleRecord(v));

  // #102: Skip cache set if serialized payload exceeds 512 KB to prevent Redis memory bloat
  const json = JSON.stringify(records);
  if (json.length > 512 * 1024) {
    logger.warn('[VehicleRepo] Vehicle cache too large, skipping', { transporterId, count: records.length, bytes: json.length });
  } else {
    redisService.set(cacheKey, json, 300).catch(err => {
      logger.warn('[VehicleRepo] Cache set failed', { error: err?.message || String(err) });
    });
  }

  return records;
}

export async function getVehiclesByType(vehicleType: string, limit = 500): Promise<VehicleRecord[]> {
  const prisma = getPrismaClient();
  const safeLimit = Math.min(Math.max(1, limit), 1000);
  const vehicles = await prisma.vehicle.findMany({
    where: { vehicleType, isActive: true },
    take: safeLimit,
    orderBy: { createdAt: 'desc' }
  });
  return vehicles.map(v => toVehicleRecord(v));
}

export async function getTransportersWithVehicleType(vehicleType: string, vehicleSubtype?: string): Promise<string[]> {
  const prisma = getPrismaClient();
  const vehicleKeyCandidates = vehicleSubtype
    ? generateVehicleKeyCandidates(vehicleType, vehicleSubtype)
    : [];

  let vehicles: Array<{ transporterId: string; vehicleType?: string; vehicleSubtype?: string }> = [];

  if (vehicleKeyCandidates.length > 0) {
    vehicles = await prisma.vehicle.findMany({
      where: {
        isActive: true,
        status: 'available',
        vehicleKey: { in: vehicleKeyCandidates },
        // KYC gate: only return vehicles owned by verified transporters
        transporter: { isVerified: true },
      },
      select: { transporterId: true, vehicleType: true, vehicleSubtype: true }
    });
  }

  if (vehicles.length === 0) {
    const typeScopedVehicles = await prisma.vehicle.findMany({
      where: {
        isActive: true,
        status: 'available',
        vehicleType: { mode: 'insensitive' as const, equals: vehicleType },
        // KYC gate: only return vehicles owned by verified transporters
        transporter: { isVerified: true },
      },
      select: { transporterId: true, vehicleType: true, vehicleSubtype: true }
    });

    if (!vehicleSubtype) {
      vehicles = typeScopedVehicles;
    } else {
      const candidateSet = new Set(vehicleKeyCandidates);
      vehicles = typeScopedVehicles.filter((vehicle) => {
        const ownTypeKey = generateVehicleKey(
          vehicle.vehicleType || vehicleType,
          vehicle.vehicleSubtype || ''
        );
        const requestedTypeKey = generateVehicleKey(vehicleType, vehicle.vehicleSubtype || '');
        return candidateSet.has(ownTypeKey) || candidateSet.has(requestedTypeKey);
      });
    }
  }

  const result = [...new Set(vehicles.map(v => v.transporterId))];
  logger.info(`Found ${result.length} transporters with ${vehicleType}${vehicleSubtype ? '/' + vehicleSubtype : ''}`, {
    matchingKeySource: vehicleSubtype ? 'vehicle_key_candidates' : 'vehicle_type_only'
  });
  return result;
}

export async function getTransportersByVehicleKey(vehicleKey: string, limit: number = 800): Promise<string[]> {
  const prisma = getPrismaClient();
  const normalizedKey = normalizeVehicleString(vehicleKey);
  if (!normalizedKey) return [];

  const vehicles = await prisma.vehicle.findMany({
    where: {
      isActive: true,
      vehicleKey: {
        equals: normalizedKey,
        mode: 'insensitive'
      }
    },
    select: {
      transporterId: true
    },
    take: Math.max(1, Math.min(limit, 2000))
  });

  return [...new Set(vehicles.map(vehicle => vehicle.transporterId))];
}

export async function updateVehicle(id: string, updates: Partial<VehicleRecord>): Promise<VehicleRecord> {
  const prisma = getPrismaClient();
  try {
    const needsOldState = updates.transporterId || updates.status;
    const oldVehicle = needsOldState
      ? await prisma.vehicle.findUnique({
          where: { id },
          select: { transporterId: true, status: true, vehicleKey: true }
        })
      : null;

    const { createdAt: _ca, updatedAt: _ua, ...data } = updates as Partial<VehicleRecord> & { createdAt?: unknown; updatedAt?: unknown };
    const updated = await prisma.vehicle.update({
      where: { id },
      data: {
        ...data,
        status: data.status ? data.status as VehicleStatus : undefined,
      }
    });
    if (updated.transporterId) {
      redisService.del(vehiclesCacheKey(updated.transporterId)).catch(err => {
        logger.warn('[VehicleRepo] Cache invalidation failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
    if (oldVehicle?.transporterId && oldVehicle.transporterId !== updated.transporterId) {
      redisService.del(vehiclesCacheKey(oldVehicle.transporterId)).catch(err => {
        logger.warn('[VehicleRepo] Cache invalidation failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
    if (oldVehicle && updates.status && oldVehicle.status !== updates.status) {
      onVehicleTransition(
        updated.transporterId, id, updated.vehicleKey || oldVehicle.vehicleKey || '',
        oldVehicle.status || 'available', updates.status, 'vehicleRepoUpdate'
      ).catch(err => logger.warn('[vehicleRepoUpdate] Vehicle transition failed:', (err as Error).message));
    }
    return toVehicleRecord(updated);
  } catch (error) {
    logger.error('DB operation failed', { operation: 'updateVehicle', id, error: error instanceof Error ? sanitizeDbError(error.message) : String(error) });
    throw error;
  }
}

export async function deleteVehicle(id: string): Promise<boolean> {
  const prisma = getPrismaClient();
  try {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id },
      select: { transporterId: true, status: true, vehicleKey: true }
    });
    await prisma.vehicle.delete({ where: { id } });
    if (vehicle?.transporterId) {
      redisService.del(vehiclesCacheKey(vehicle.transporterId)).catch(err => {
        logger.warn('[VehicleRepo] Cache invalidation failed', { error: err?.message || String(err) });
      });
    }
    if (vehicle && vehicle.status === 'available' && vehicle.vehicleKey) {
      liveAvailabilityService.onVehicleRemoved(vehicle.transporterId, vehicle.vehicleKey)
        .catch(err => logger.warn('[LiveAvail] deleteVehicle hook failed:', (err as Error).message));
    }
    return true;
  } catch (error) {
    logger.error('DB operation failed', { error: error instanceof Error ? sanitizeDbError(error.message) : String(error) });
    return false;
  }
}

export async function getTransporterAvailableTrucks(
  transporterId: string,
  vehicleType: string,
  vehicleSubtype?: string
): Promise<{ totalOwned: number; available: number; inTransit: number; maintenance: number }> {
  const vehicles = await getVehiclesByTransporter(transporterId);

  const matchingVehicles = vehicles.filter(v => {
    if (!v.isActive) return false;
    if (!vehicleStringsMatch(v.vehicleType, vehicleType)) return false;
    if (vehicleSubtype && !vehicleStringsMatch(v.vehicleSubtype, vehicleSubtype)) return false;
    return true;
  });

  return {
    totalOwned: matchingVehicles.length,
    available: matchingVehicles.filter(v => v.status === 'available').length,
    inTransit: matchingVehicles.filter(v => v.status === 'in_transit').length,
    maintenance: matchingVehicles.filter(v => v.status === 'maintenance').length,
  };
}

export async function getTransportersAvailabilitySnapshot(
  vehicleType: string,
  vehicleSubtype?: string
): Promise<Array<{ transporterId: string; transporterName: string; totalOwned: number; available: number; inTransit: number }>> {
  const prisma = getPrismaClient();

  // Live Redis: try Redis snapshot first
  try {
    const vehicleKey = vehicleSubtype
      ? generateVehicleKey(vehicleType, vehicleSubtype)
      : generateVehicleKey(vehicleType, '');
    const redisResult = await liveAvailabilityService.getSnapshotFromRedis(vehicleKey);
    if (redisResult && redisResult.length > 0) {
      logger.debug(`[AvailSnapshot] Live Redis: ${redisResult.length} transporters for ${vehicleKey}`);
      return redisResult;
    }
  } catch (error) {
    logger.warn('Redis availability snapshot failed, falling back to DB', { error: error instanceof Error ? error.message : String(error) });
  }

  const vehicleKeyCandidates = vehicleSubtype
    ? generateVehicleKeyCandidates(vehicleType, vehicleSubtype)
    : [];

  let matchingVehicles: Array<{ transporterId: string; status: VehicleStatus; vehicleType?: string; vehicleSubtype?: string }> = [];
  if (vehicleKeyCandidates.length > 0) {
    matchingVehicles = await prisma.vehicle.findMany({
      where: {
        isActive: true,
        vehicleKey: { in: vehicleKeyCandidates }
      },
      select: { transporterId: true, status: true, vehicleType: true, vehicleSubtype: true }
    });
  }

  if (matchingVehicles.length === 0) {
    const typeScopedVehicles = await prisma.vehicle.findMany({
      where: {
        isActive: true,
        vehicleType: { mode: 'insensitive' as const, equals: vehicleType }
      },
      select: { transporterId: true, status: true, vehicleType: true, vehicleSubtype: true }
    });

    if (!vehicleSubtype) {
      matchingVehicles = typeScopedVehicles;
    } else {
      const candidateSet = new Set(vehicleKeyCandidates);
      matchingVehicles = typeScopedVehicles.filter((vehicle) => {
        const ownTypeKey = generateVehicleKey(
          vehicle.vehicleType || vehicleType,
          vehicle.vehicleSubtype || ''
        );
        const requestedTypeKey = generateVehicleKey(vehicleType, vehicle.vehicleSubtype || '');
        return candidateSet.has(ownTypeKey) || candidateSet.has(requestedTypeKey);
      });
    }
  }

  const transporterMap = new Map<string, { available: number; inTransit: number; total: number }>();

  for (const vehicle of matchingVehicles) {
    if (!transporterMap.has(vehicle.transporterId)) {
      transporterMap.set(vehicle.transporterId, { available: 0, inTransit: 0, total: 0 });
    }
    const stats = transporterMap.get(vehicle.transporterId)!;
    stats.total++;
    if (vehicle.status === 'available') stats.available++;
    if (vehicle.status === 'in_transit') stats.inTransit++;
  }

  const transporterIds = Array.from(transporterMap.keys());
  const transporters = await prisma.user.findMany({
    where: { id: { in: transporterIds } },
    select: { id: true, name: true, businessName: true }
  });

  const nameMap = new Map(
    transporters.map(t => [t.id, t.businessName || t.name || 'Unknown'])
  );

  const result: Array<{ transporterId: string; transporterName: string; totalOwned: number; available: number; inTransit: number }> = [];

  for (const [transporterId, stats] of transporterMap) {
    result.push({
      transporterId,
      transporterName: nameMap.get(transporterId) || 'Unknown',
      totalOwned: stats.total,
      available: stats.available,
      inTransit: stats.inTransit,
    });
  }

  return result.filter(t => t.available > 0);
}
