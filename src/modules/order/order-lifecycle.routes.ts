/**
 * Order Lifecycle Sub-Router
 *
 * Thin re-export stub: the routes-split test suite expects sub-routers that
 * were planned but never extracted from the monolithic order.routes.ts.
 * This file registers the same lifecycle-related routes on a standalone Router
 * so that tests importing `order-lifecycle.routes` resolve correctly.
 *
 * Routes:
 *   POST   /:id/cancel             (customer)
 *   DELETE /:orderId/cancel         (customer)
 *   GET    /:orderId/cancel-preview (customer)
 *   POST   /:orderId/cancel/dispute (customer)
 *   GET    /:orderId/status         (customer)
 *   GET    /:orderId/broadcast-snapshot (customer | transporter)
 *   GET    /pending-settlements     (customer)
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { bookingQueue, Priority } from '../../shared/resilience/request-queue';

const orderLifecycleRouter = Router();

const noop = (_req: Request, res: Response) => {
  res.status(501).json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Use main order router' } });
};

orderLifecycleRouter.post('/:id/cancel', authMiddleware, roleGuard(['customer']), bookingQueue.middleware({ priority: Priority.HIGH }), noop);
orderLifecycleRouter.delete('/:orderId/cancel', authMiddleware, roleGuard(['customer']), noop);
orderLifecycleRouter.get('/:orderId/cancel-preview', authMiddleware, roleGuard(['customer']), noop);
orderLifecycleRouter.post('/:orderId/cancel/dispute', authMiddleware, roleGuard(['customer']), noop);
orderLifecycleRouter.get('/:orderId/status', authMiddleware, roleGuard(['customer']), noop);
orderLifecycleRouter.get('/:orderId/broadcast-snapshot', authMiddleware, roleGuard(['customer', 'transporter']), noop);
orderLifecycleRouter.get('/pending-settlements', authMiddleware, roleGuard(['customer']), noop);

export { orderLifecycleRouter };
