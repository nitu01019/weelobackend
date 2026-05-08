/**
 * =============================================================================
 * TRIP PII ROUTES (V11-NEW-10 / P5-8)
 * =============================================================================
 *
 * Single endpoint paired with the captain Room migration:
 *
 *   GET /api/v1/trips/:tripId/pii
 *
 * Returns unmasked customer PII (name + phone + pickup address/lat/lng) to
 * the *currently assigned driver* only. All other Socket.IO / FCM / list
 * payloads must continue to deliver masked values via maskName /
 * maskPhoneForExternal — this route is the single gated reveal point used
 * by the captain app once the driver opens the Trip Room.
 *
 * Security model:
 *   - authMiddleware       → JWT must validate
 *   - roleGuard(['driver']) → caller must be a driver (defence-in-depth)
 *   - BOLA guard           → assignment.driverId === req.user.userId,
 *                             else 403 NOT_ASSIGNED_DRIVER
 *   - per-driverId rate limit (60/min)
 *
 * Logging: never emit raw phone / name; use phoneLast4 + structured meta
 * per DPDP §5(b).
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { transporterRateLimit } from '../../shared/middleware/transporter-rate-limit.middleware';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { phoneLast4 } from '../../shared/utils/pii.utils';

const router = Router();

interface PickupShape {
  latitude?: number;
  longitude?: number;
  address?: string;
}

/**
 * Extract the canonical pickup point regardless of legacy booking vs.
 * multi-truck order origin. Both models store pickup as a JSON column with
 * the canonical { latitude, longitude, address } shape.
 *
 * Returns zero/empty defaults rather than throwing — a partially-populated
 * trip should still return a 200 so the captain UI can render whatever it
 * has, with the missing fields surfaced as empty.
 */
function extractPickup(pickup: unknown): { latitude: number; longitude: number; address: string } {
  if (!pickup || typeof pickup !== 'object') {
    return { latitude: 0, longitude: 0, address: '' };
  }
  const p = pickup as PickupShape;
  return {
    latitude: typeof p.latitude === 'number' ? p.latitude : 0,
    longitude: typeof p.longitude === 'number' ? p.longitude : 0,
    address: typeof p.address === 'string' ? p.address : '',
  };
}

/**
 * @route   GET /trips/:tripId/pii
 * @desc    Reveal unmasked customer PII to the assigned driver only.
 * @access  Driver only (assigned driver)
 */
router.get(
  '/:tripId/pii',
  authMiddleware,
  roleGuard(['driver']),
  transporterRateLimit('tripPiiReveal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tripId } = req.params;
      const driverId = req.user!.userId;

      // Trip lookup: assignment.tripId is unique per schema.prisma.
      // Pull customer fields off the booking/order parent (canonical PII source).
      const assignment = await prismaClient.assignment.findUnique({
        where: { tripId },
        select: {
          driverId: true,
          driverPhone: true,
          booking: {
            select: { customerName: true, customerPhone: true, pickup: true },
          },
          order: {
            select: { customerName: true, customerPhone: true, pickup: true },
          },
        },
      });

      if (!assignment) {
        return res.status(404).json({ error: 'TRIP_NOT_FOUND' });
      }

      // BOLA guard: requesting driver must own this assignment.
      if (assignment.driverId !== driverId) {
        logger.warn('[trip-pii] BOLA attempt blocked', {
          tripId,
          phoneLast4: phoneLast4(assignment.driverPhone),
        });
        return res.status(403).json({ error: 'NOT_ASSIGNED_DRIVER' });
      }

      const customerSource = assignment.booking ?? assignment.order;
      const customerName = customerSource?.customerName ?? '';
      const customerPhone = customerSource?.customerPhone ?? '';
      const pickup = extractPickup(customerSource?.pickup);

      logger.info('[trip-pii] reveal', {
        tripId,
        phoneLast4: phoneLast4(customerPhone),
      });

      return res.status(200).json({
        tripId,
        customerName,
        customerPhone,
        pickupAddress: pickup.address,
        pickupLat: pickup.latitude,
        pickupLng: pickup.longitude,
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as tripRouter };
