"use strict";
/**
 * =============================================================================
 * PRICING MODULE - INDEX
 * =============================================================================
 *
 * Public exports for the pricing module.
 * Handles fare estimation for bookings.
 * =============================================================================
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pricingService = exports.pricingRouter = void 0;
var pricing_routes_1 = require("./pricing.routes");
Object.defineProperty(exports, "pricingRouter", { enumerable: true, get: function () { return pricing_routes_1.pricingRouter; } });
var pricing_service_1 = require("./pricing.service");
Object.defineProperty(exports, "pricingService", { enumerable: true, get: function () { return pricing_service_1.pricingService; } });
__exportStar(require("./pricing.schema"), exports);
//# sourceMappingURL=index.js.map