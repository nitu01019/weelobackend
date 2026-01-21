/**
 * =============================================================================
 * TRANSPORTER ROUTES - API for transporter operations
 * =============================================================================
 *
 * ENDPOINTS:
 * - PUT  /api/v1/transporter/availability   - Update online/offline status
 * - GET  /api/v1/transporter/availability   - Get current availability status
 * - GET  /api/v1/transporter/profile        - Get transporter profile
 * - PUT  /api/v1/transporter/profile        - Update transporter profile
 * - GET  /api/v1/transporter/stats          - Get transporter statistics
 *
 * AVAILABILITY FEATURE:
 * - When transporter is OFFLINE, they won't receive broadcasts
 * - Even if their vehicles match the request
 * - Used for breaks, end of day, etc.
 *
 * =============================================================================
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=transporter.routes.d.ts.map