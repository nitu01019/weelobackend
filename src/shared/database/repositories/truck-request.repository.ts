/**
 * =============================================================================
 * TRUCK REQUEST REPOSITORY — TruckRequest CRUD + batch ops
 * =============================================================================
 */

import { TruckRequestStatus, Prisma } from '@prisma/client';
import { getPrismaClient, sanitizeDbError } from '../prisma-client';
import { toTruckRequestRecord, vehicleStringsMatch } from '../record-helpers';
import type { TruckRequestRecord } from '../record-types';
import { logger } from '../../services/logger.service';
import { generateVehicleKey, generateVehicleKeyCandidates } from '../../services/vehicle-key.service';
import { getVehiclesByTransporter } from './vehicle.repository';

export async function createTruckRequest(request: Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'>): Promise<TruckRequestRecord> {
  const prisma = getPrismaClient();
  const created = await prisma.truckRequest.create({
    data: {
      id: request.id,
      orderId: request.orderId,
      requestNumber: request.requestNumber,
      vehicleType: request.vehicleType,
      vehicleSubtype: request.vehicleSubtype,
      pricePerTruck: request.pricePerTruck,
      status: request.status as TruckRequestStatus,
      heldById: request.heldBy || null,
      heldAt: request.heldAt || null,
      assignedTransporterId: request.assignedTransporterId || request.assignedTo || null,
      assignedTransporterName: request.assignedTransporterName || null,
      assignedVehicleId: request.assignedVehicleId || null,
      assignedVehicleNumber: request.assignedVehicleNumber || null,
      assignedDriverId: request.assignedDriverId || null,
      assignedDriverName: request.assignedDriverName || null,
      assignedDriverPhone: request.assignedDriverPhone || null,
      tripId: request.tripId || null,
      notifiedTransporters: request.notifiedTransporters || [],
      assignedAt: request.assignedAt || null,
    }
  });
  logger.info(`TruckRequest created: ${request.id} (${request.vehicleType} ${request.vehicleSubtype})`);
  return toTruckRequestRecord(created);
}

export async function createTruckRequestsBatch(requests: Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'>[]): Promise<TruckRequestRecord[]> {
  const prisma = getPrismaClient();
  if (requests.length === 0) return [];

  await prisma.truckRequest.createMany({
    data: requests.map(request => ({
      id: request.id,
      orderId: request.orderId,
      requestNumber: request.requestNumber,
      vehicleType: request.vehicleType,
      vehicleSubtype: request.vehicleSubtype,
      pricePerTruck: request.pricePerTruck,
      status: request.status as TruckRequestStatus,
      heldById: request.heldBy || null,
      heldAt: request.heldAt || null,
      assignedTransporterId: request.assignedTransporterId || request.assignedTo || null,
      assignedTransporterName: request.assignedTransporterName || null,
      assignedVehicleId: request.assignedVehicleId || null,
      assignedVehicleNumber: request.assignedVehicleNumber || null,
      assignedDriverId: request.assignedDriverId || null,
      assignedDriverName: request.assignedDriverName || null,
      assignedDriverPhone: request.assignedDriverPhone || null,
      tripId: request.tripId || null,
      notifiedTransporters: request.notifiedTransporters || [],
      assignedAt: request.assignedAt || null,
    })),
    skipDuplicates: true,
  });

  const ids = requests.map(r => r.id);
  const created = await prisma.truckRequest.findMany({
    where: { id: { in: ids } }
  });

  logger.info(`TruckRequests batch created: ${created.length} requests (single round-trip)`);
  return created.map(r => toTruckRequestRecord(r));
}

export async function getTruckRequestById(id: string): Promise<TruckRequestRecord | undefined> {
  const prisma = getPrismaClient();
  const request = await prisma.truckRequest.findUnique({ where: { id } });
  return request ? toTruckRequestRecord(request) : undefined;
}

export async function getTruckRequestsByOrder(orderId: string): Promise<TruckRequestRecord[]> {
  const prisma = getPrismaClient();
  const requests = await prisma.truckRequest.findMany({ where: { orderId } });
  return requests.map(r => toTruckRequestRecord(r));
}

export async function getActiveTruckRequestsForTransporter(transporterId: string): Promise<TruckRequestRecord[]> {
  const prisma = getPrismaClient();
  const vehicles = await getVehiclesByTransporter(transporterId);
  const activeVehiclePairs = Array.from(
    new Map(
      vehicles
        .filter(v => v.isActive)
        .map(v => {
          const normalizedType = (v.vehicleType || '').trim();
          const normalizedSubtype = (v.vehicleSubtype || '').trim();
          return [
            generateVehicleKey(normalizedType, normalizedSubtype),
            { vehicleType: normalizedType, vehicleSubtype: normalizedSubtype }
          ] as const;
        })
    ).values()
  );
  if (activeVehiclePairs.length === 0) {
    return [];
  }

  try {
    return await getActiveTruckRequestsForTransporterIndexed(
      transporterId,
      activeVehiclePairs
    );
  } catch (error: unknown) {
    logger.warn('[DB] Indexed transporter request query failed, falling back to in-memory filter', {
      transporterId,
      error: error instanceof Error ? error.message : 'unknown'
    });
  }

  const candidateVehicleKeys = new Set(
    activeVehiclePairs.flatMap((pair) => generateVehicleKeyCandidates(pair.vehicleType, pair.vehicleSubtype))
  );
  const requests = await prisma.truckRequest.findMany({
    where: {
      status: 'searching',
      notifiedTransporters: { has: transporterId }
    },
    orderBy: { createdAt: 'desc' },
    take: 500
  });

  const maxArrayLen = requests.reduce(
    (max, r) => Math.max(max, (r.notifiedTransporters as string[])?.length ?? 0), 0
  );
  if (maxArrayLen > 50) {
    logger.warn('[DB] notifiedTransporters array exceeding 50 elements', {
      maxArrayLen, transporterId, requestCount: requests.length,
      hint: 'Consider migrating to TruckRequestNotification junction table'
    });
  }

  return requests
    .filter(request => {
      const requestKeys = generateVehicleKeyCandidates(request.vehicleType, request.vehicleSubtype || '');
      return requestKeys.some((key) => candidateVehicleKeys.has(key));
    })
    .map(request => toTruckRequestRecord(request));
}

export async function getActiveTruckRequestsForTransporterIndexed(
  transporterId: string,
  vehiclePairs: Array<{ vehicleType: string; vehicleSubtype: string }>,
  limit: number = 500
): Promise<TruckRequestRecord[]> {
  const prisma = getPrismaClient();
  if (vehiclePairs.length === 0) return [];

  const candidateVehicleKeys = new Set(
    vehiclePairs.flatMap((pair) => generateVehicleKeyCandidates(pair.vehicleType, pair.vehicleSubtype))
  );
  const requests = await prisma.truckRequest.findMany({
    where: {
      status: 'searching',
      notifiedTransporters: { has: transporterId }
    },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(limit, 1000))
  });

  return requests
    .filter((request) => {
      const requestKeys = generateVehicleKeyCandidates(request.vehicleType, request.vehicleSubtype || '');
      return requestKeys.some((key) => candidateVehicleKeys.has(key));
    })
    .map(request => toTruckRequestRecord(request));
}

export async function getTruckRequestsByVehicleType(vehicleType: string, vehicleSubtype?: string): Promise<TruckRequestRecord[]> {
  const prisma = getPrismaClient();
  const MAX_RESULTS = parseInt(process.env.MAX_TRUCK_REQUESTS_QUERY || '500', 10);

  const requests = await prisma.truckRequest.findMany({
    where: {
      status: 'searching',
      vehicleType: { equals: vehicleType, mode: 'insensitive' as const },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_RESULTS,
  });

  if (requests.length >= MAX_RESULTS) {
    logger.warn('[DB] getTruckRequestsByVehicleType hit cap', {
      vehicleType,
      vehicleSubtype: vehicleSubtype || '(any)',
      cap: MAX_RESULTS,
    });
  }

  return requests
    .filter(r => {
      if (vehicleSubtype && !vehicleStringsMatch(r.vehicleSubtype, vehicleSubtype)) return false;
      return true;
    })
    .map(r => toTruckRequestRecord(r));
}

export async function updateTruckRequest(id: string, updates: Partial<TruckRequestRecord>): Promise<TruckRequestRecord | undefined> {
  const prisma = getPrismaClient();
  try {
    const { createdAt: _ca, updatedAt: _ua, heldBy, assignedTo, ...data } = updates as Partial<TruckRequestRecord> & { createdAt?: unknown; updatedAt?: unknown };
    const updated = await prisma.truckRequest.update({
      where: { id },
      data: {
        ...data,
        heldById: heldBy !== undefined ? (heldBy as string | null) : undefined,
        assignedTransporterId: assignedTo !== undefined ? (assignedTo as string | null) : data.assignedTransporterId,
        status: data.status ? data.status as TruckRequestStatus : undefined,
      }
    });
    return toTruckRequestRecord(updated);
  } catch (error) {
    logger.error('DB operation failed', { error: error instanceof Error ? sanitizeDbError(error.message) : String(error) });
    return undefined;
  }
}

export async function updateTruckRequestsBatch(ids: string[], updates: Partial<TruckRequestRecord>): Promise<number> {
  const prisma = getPrismaClient();
  if (ids.length === 0) return 0;

  const { createdAt, updatedAt, heldBy, assignedTo, ...data } = updates as Partial<TruckRequestRecord & { createdAt?: string; updatedAt?: string }>;
  const prismaData: Prisma.TruckRequestUncheckedUpdateInput = { ...data } as Prisma.TruckRequestUncheckedUpdateInput;

  if (heldBy !== undefined) prismaData.heldById = heldBy;
  if (assignedTo !== undefined) prismaData.assignedTransporterId = assignedTo;
  if (prismaData.status) prismaData.status = prismaData.status as TruckRequestStatus;

  const result = await prisma.truckRequest.updateMany({
    where: { id: { in: ids } },
    data: prismaData,
  });

  return result.count;
}
