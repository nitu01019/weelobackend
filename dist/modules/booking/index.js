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
exports.bookingService = exports.bookingRouter = void 0;
/**
 * Booking Module - Public Exports
 */
var booking_routes_1 = require("./booking.routes");
Object.defineProperty(exports, "bookingRouter", { enumerable: true, get: function () { return booking_routes_1.bookingRouter; } });
var booking_service_1 = require("./booking.service");
Object.defineProperty(exports, "bookingService", { enumerable: true, get: function () { return booking_service_1.bookingService; } });
__exportStar(require("./booking.schema"), exports);
//# sourceMappingURL=index.js.map