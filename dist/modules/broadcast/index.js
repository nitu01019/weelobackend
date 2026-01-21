"use strict";
/**
 * =============================================================================
 * BROADCAST MODULE - INDEX
 * =============================================================================
 *
 * Public exports for the broadcast module.
 * Broadcasts notify transporters/drivers of new booking requests.
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
exports.broadcastService = exports.broadcastRouter = void 0;
var broadcast_routes_1 = require("./broadcast.routes");
Object.defineProperty(exports, "broadcastRouter", { enumerable: true, get: function () { return broadcast_routes_1.broadcastRouter; } });
var broadcast_service_1 = require("./broadcast.service");
Object.defineProperty(exports, "broadcastService", { enumerable: true, get: function () { return broadcast_service_1.broadcastService; } });
__exportStar(require("./broadcast.schema"), exports);
//# sourceMappingURL=index.js.map