"use strict";
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
exports.trackingService = exports.trackingRouter = void 0;
/**
 * Tracking Module - Public Exports
 */
var tracking_routes_1 = require("./tracking.routes");
Object.defineProperty(exports, "trackingRouter", { enumerable: true, get: function () { return tracking_routes_1.trackingRouter; } });
var tracking_service_1 = require("./tracking.service");
Object.defineProperty(exports, "trackingService", { enumerable: true, get: function () { return tracking_service_1.trackingService; } });
__exportStar(require("./tracking.schema"), exports);
//# sourceMappingURL=index.js.map