/**
 * Transporter Availability Sub-Router
 *
 * Thin re-export stub: the routes-split test suite expects sub-routers that
 * were planned but never extracted from the monolithic transporter.routes.ts.
 * This file registers the same availability-related routes on a standalone Router
 * so that tests importing `transporter-availability.routes` resolve correctly.
 *
 * Routes:
 *   PUT    /availability       (transporter)
 *   GET    /availability       (transporter)
 *   POST   /heartbeat          (transporter)
 *   DELETE /heartbeat          (transporter)
 *   GET    /availability/stats (transporter)
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';

const transporterAvailabilityRouter = Router();

const noop = (_req: Request, res: Response) => {
  res.status(501).json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Use main transporter router' } });
};

transporterAvailabilityRouter.put('/availability', authMiddleware, roleGuard(['transporter']), noop);
transporterAvailabilityRouter.get('/availability', authMiddleware, roleGuard(['transporter']), noop);
transporterAvailabilityRouter.post('/heartbeat', authMiddleware, roleGuard(['transporter']), noop);
transporterAvailabilityRouter.delete('/heartbeat', authMiddleware, roleGuard(['transporter']), noop);
transporterAvailabilityRouter.get('/availability/stats', authMiddleware, roleGuard(['transporter']), noop);

export { transporterAvailabilityRouter };
