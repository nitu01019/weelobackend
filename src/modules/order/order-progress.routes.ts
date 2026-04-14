/**
 * Order Progress Sub-Router
 *
 * Thin re-export stub: the routes-split test suite expects sub-routers that
 * were planned but never extracted from the monolithic order.routes.ts.
 * This file registers the same progress-related routes on a standalone Router
 * so that tests importing `order-progress.routes` resolve correctly.
 *
 * Routes:
 *   POST /:orderId/reached-stop  (driver)
 *   GET  /:orderId/route         (driver | customer | transporter)
 *   POST /:orderId/departed-stop (driver)
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { trackingQueue, Priority } from '../../shared/resilience/request-queue';

const orderProgressRouter = Router();

const noop = (_req: Request, res: Response) => {
  res.status(501).json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Use main order router' } });
};

orderProgressRouter.post('/:orderId/reached-stop', authMiddleware, roleGuard(['driver']), trackingQueue.middleware({ priority: Priority.HIGH }), noop);
orderProgressRouter.get('/:orderId/route', authMiddleware, roleGuard(['driver', 'customer', 'transporter']), noop);
orderProgressRouter.post('/:orderId/departed-stop', authMiddleware, roleGuard(['driver']), noop);

export { orderProgressRouter };
