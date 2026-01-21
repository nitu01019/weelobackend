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
exports.assignmentService = exports.assignmentRouter = void 0;
/**
 * Assignment Module - Public Exports
 */
var assignment_routes_1 = require("./assignment.routes");
Object.defineProperty(exports, "assignmentRouter", { enumerable: true, get: function () { return assignment_routes_1.assignmentRouter; } });
var assignment_service_1 = require("./assignment.service");
Object.defineProperty(exports, "assignmentService", { enumerable: true, get: function () { return assignment_service_1.assignmentService; } });
__exportStar(require("./assignment.schema"), exports);
//# sourceMappingURL=index.js.map