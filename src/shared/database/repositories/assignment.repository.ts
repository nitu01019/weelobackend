/**
 * =============================================================================
 * ASSIGNMENT REPOSITORY — Assignment CRUD operations
 * =============================================================================
 */

import { AssignmentStatus } from '@prisma/client';
import { getPrismaClient, sanitizeDbError, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../prisma-client';
import { toAssignmentRecord } from '../record-helpers';
import type { AssignmentRecord } from '../record-types';
import { logger } from '../../services/logger.service';

export async function createAssignment(assignment: AssignmentRecord): Promise<AssignmentRecord> {
  const prisma = getPrismaClient();
  const created = await prisma.assignment.create({
    data: {
      ...assignment,
      status: assignment.status as AssignmentStatus,
    }
  });
  logger.info(`Assignment created: ${assignment.id} for booking ${assignment.bookingId}`);
  return toAssignmentRecord(created);
}

export async function getAssignmentById(id: string): Promise<AssignmentRecord | undefined> {
  const prisma = getPrismaClient();
  const assignment = await prisma.assignment.findUnique({ where: { id } });
  return assignment ? toAssignmentRecord(assignment) : undefined;
}

export async function getAssignmentsByBooking(bookingId: string): Promise<AssignmentRecord[]> {
  const prisma = getPrismaClient();
  const assignments = await prisma.assignment.findMany({ where: { bookingId } });
  return assignments.map(a => toAssignmentRecord(a));
}

export async function getAssignmentsByDriver(driverId: string, limit: number = DEFAULT_PAGE_SIZE): Promise<AssignmentRecord[]> {
  const prisma = getPrismaClient();
  const assignments = await prisma.assignment.findMany({
    where: { driverId },
    take: Math.min(limit, MAX_PAGE_SIZE),
    orderBy: { assignedAt: 'desc' }
  });
  return assignments.map(a => toAssignmentRecord(a));
}

export async function getAssignmentsByTransporter(transporterId: string, limit: number = DEFAULT_PAGE_SIZE): Promise<AssignmentRecord[]> {
  const prisma = getPrismaClient();
  const assignments = await prisma.assignment.findMany({
    where: { transporterId },
    take: Math.min(limit, MAX_PAGE_SIZE),
    orderBy: { assignedAt: 'desc' }
  });
  return assignments.map(a => toAssignmentRecord(a));
}

export async function getActiveAssignmentByDriver(driverId: string): Promise<AssignmentRecord | undefined> {
  const prisma = getPrismaClient();
  const activeStatuses: AssignmentStatus[] = ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'];
  const assignment = await prisma.assignment.findFirst({
    where: {
      driverId,
      status: { in: activeStatuses }
    }
  });
  return assignment ? toAssignmentRecord(assignment) : undefined;
}

export async function updateAssignment(id: string, updates: Partial<AssignmentRecord>): Promise<AssignmentRecord> {
  const prisma = getPrismaClient();
  try {
    const updated = await prisma.assignment.update({
      where: { id },
      data: {
        ...updates,
        status: updates.status ? updates.status as AssignmentStatus : undefined,
      }
    });
    return toAssignmentRecord(updated);
  } catch (error) {
    logger.error('DB operation failed', { operation: 'updateAssignment', id, error: error instanceof Error ? sanitizeDbError(error.message) : String(error) });
    throw error;
  }
}
