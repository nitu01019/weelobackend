/**
 * =============================================================================
 * BOOKING MODULE - VALIDATION SCHEMAS
 * =============================================================================
 *
 * NEW ARCHITECTURE: Multi-Truck Request System
 *
 * Order (Parent) → TruckRequests (Children)
 *
 * Customer selects: 2x Open 17ft + 3x Container 4ton
 * System creates: 1 Order with 5 TruckRequests
 * Each TruckRequest is broadcast to matching transporters
 * =============================================================================
 */
import { z } from 'zod';
/**
 * Individual Truck Selection (from customer)
 */
export declare const truckSelectionSchema: z.ZodObject<{
    vehicleType: z.ZodEnum<["mini", "lcv", "tipper", "container", "trailer", "tanker", "bulker", "open", "dumper", "tractor"]>;
    vehicleSubtype: z.ZodString;
    quantity: z.ZodNumber;
    pricePerTruck: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    vehicleType: "mini" | "lcv" | "tipper" | "container" | "trailer" | "tanker" | "bulker" | "open" | "dumper" | "tractor";
    vehicleSubtype: string;
    pricePerTruck: number;
    quantity: number;
}, {
    vehicleType: "mini" | "lcv" | "tipper" | "container" | "trailer" | "tanker" | "bulker" | "open" | "dumper" | "tractor";
    vehicleSubtype: string;
    pricePerTruck: number;
    quantity: number;
}>;
/**
 * Create Booking Schema (LEGACY - Single truck type)
 * Kept for backward compatibility
 */
export declare const createBookingSchema: z.ZodObject<{
    pickup: z.ZodObject<{
        coordinates: z.ZodObject<{
            latitude: z.ZodNumber;
            longitude: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            latitude: number;
            longitude: number;
        }, {
            latitude: number;
            longitude: number;
        }>;
        address: z.ZodString;
        city: z.ZodOptional<z.ZodString>;
        state: z.ZodOptional<z.ZodString>;
        pincode: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    }, {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    }>;
    drop: z.ZodObject<{
        coordinates: z.ZodObject<{
            latitude: z.ZodNumber;
            longitude: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            latitude: number;
            longitude: number;
        }, {
            latitude: number;
            longitude: number;
        }>;
        address: z.ZodString;
        city: z.ZodOptional<z.ZodString>;
        state: z.ZodOptional<z.ZodString>;
        pincode: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    }, {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    }>;
    vehicleType: z.ZodEnum<["mini", "lcv", "tipper", "container", "trailer", "tanker", "bulker", "open", "dumper", "tractor"]>;
    vehicleSubtype: z.ZodString;
    trucksNeeded: z.ZodNumber;
    distanceKm: z.ZodNumber;
    pricePerTruck: z.ZodNumber;
    goodsType: z.ZodOptional<z.ZodString>;
    weight: z.ZodOptional<z.ZodString>;
    cargoWeightKg: z.ZodOptional<z.ZodNumber>;
    capacityInfo: z.ZodOptional<z.ZodObject<{
        capacityKg: z.ZodOptional<z.ZodNumber>;
        capacityTons: z.ZodOptional<z.ZodNumber>;
        minTonnage: z.ZodOptional<z.ZodNumber>;
        maxTonnage: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        capacityKg?: number | undefined;
        capacityTons?: number | undefined;
        minTonnage?: number | undefined;
        maxTonnage?: number | undefined;
    }, {
        capacityKg?: number | undefined;
        capacityTons?: number | undefined;
        minTonnage?: number | undefined;
        maxTonnage?: number | undefined;
    }>>;
    scheduledAt: z.ZodOptional<z.ZodString>;
    notes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    vehicleType: "mini" | "lcv" | "tipper" | "container" | "trailer" | "tanker" | "bulker" | "open" | "dumper" | "tractor";
    vehicleSubtype: string;
    pickup: {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    };
    drop: {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    };
    trucksNeeded: number;
    distanceKm: number;
    pricePerTruck: number;
    goodsType?: string | undefined;
    weight?: string | undefined;
    scheduledAt?: string | undefined;
    cargoWeightKg?: number | undefined;
    capacityInfo?: {
        capacityKg?: number | undefined;
        capacityTons?: number | undefined;
        minTonnage?: number | undefined;
        maxTonnage?: number | undefined;
    } | undefined;
    notes?: string | undefined;
}, {
    vehicleType: "mini" | "lcv" | "tipper" | "container" | "trailer" | "tanker" | "bulker" | "open" | "dumper" | "tractor";
    vehicleSubtype: string;
    pickup: {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    };
    drop: {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    };
    trucksNeeded: number;
    distanceKm: number;
    pricePerTruck: number;
    goodsType?: string | undefined;
    weight?: string | undefined;
    scheduledAt?: string | undefined;
    cargoWeightKg?: number | undefined;
    capacityInfo?: {
        capacityKg?: number | undefined;
        capacityTons?: number | undefined;
        minTonnage?: number | undefined;
        maxTonnage?: number | undefined;
    } | undefined;
    notes?: string | undefined;
}>;
/**
 * Create Order Schema (NEW - Multi-truck types)
 *
 * This is the primary schema for creating bookings with multiple truck types.
 * Each truck selection expands into individual TruckRequests.
 */
export declare const createOrderSchema: z.ZodObject<{
    pickup: z.ZodObject<{
        coordinates: z.ZodObject<{
            latitude: z.ZodNumber;
            longitude: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            latitude: number;
            longitude: number;
        }, {
            latitude: number;
            longitude: number;
        }>;
        address: z.ZodString;
        city: z.ZodOptional<z.ZodString>;
        state: z.ZodOptional<z.ZodString>;
        pincode: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    }, {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    }>;
    drop: z.ZodObject<{
        coordinates: z.ZodObject<{
            latitude: z.ZodNumber;
            longitude: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            latitude: number;
            longitude: number;
        }, {
            latitude: number;
            longitude: number;
        }>;
        address: z.ZodString;
        city: z.ZodOptional<z.ZodString>;
        state: z.ZodOptional<z.ZodString>;
        pincode: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    }, {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    }>;
    distanceKm: z.ZodNumber;
    trucks: z.ZodArray<z.ZodObject<{
        vehicleType: z.ZodEnum<["mini", "lcv", "tipper", "container", "trailer", "tanker", "bulker", "open", "dumper", "tractor"]>;
        vehicleSubtype: z.ZodString;
        quantity: z.ZodNumber;
        pricePerTruck: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        vehicleType: "mini" | "lcv" | "tipper" | "container" | "trailer" | "tanker" | "bulker" | "open" | "dumper" | "tractor";
        vehicleSubtype: string;
        pricePerTruck: number;
        quantity: number;
    }, {
        vehicleType: "mini" | "lcv" | "tipper" | "container" | "trailer" | "tanker" | "bulker" | "open" | "dumper" | "tractor";
        vehicleSubtype: string;
        pricePerTruck: number;
        quantity: number;
    }>, "many">;
    goodsType: z.ZodOptional<z.ZodString>;
    weight: z.ZodOptional<z.ZodString>;
    cargoWeightKg: z.ZodOptional<z.ZodNumber>;
    scheduledAt: z.ZodOptional<z.ZodString>;
    notes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    pickup: {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    };
    drop: {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    };
    distanceKm: number;
    trucks: {
        vehicleType: "mini" | "lcv" | "tipper" | "container" | "trailer" | "tanker" | "bulker" | "open" | "dumper" | "tractor";
        vehicleSubtype: string;
        pricePerTruck: number;
        quantity: number;
    }[];
    goodsType?: string | undefined;
    weight?: string | undefined;
    scheduledAt?: string | undefined;
    cargoWeightKg?: number | undefined;
    notes?: string | undefined;
}, {
    pickup: {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    };
    drop: {
        coordinates: {
            latitude: number;
            longitude: number;
        };
        address: string;
        city?: string | undefined;
        state?: string | undefined;
        pincode?: string | undefined;
    };
    distanceKm: number;
    trucks: {
        vehicleType: "mini" | "lcv" | "tipper" | "container" | "trailer" | "tanker" | "bulker" | "open" | "dumper" | "tractor";
        vehicleSubtype: string;
        pricePerTruck: number;
        quantity: number;
    }[];
    goodsType?: string | undefined;
    weight?: string | undefined;
    scheduledAt?: string | undefined;
    cargoWeightKg?: number | undefined;
    notes?: string | undefined;
}>;
/**
 * Get Bookings Query Schema
 */
export declare const getBookingsQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
} & {
    status: z.ZodOptional<z.ZodEnum<["active", "partially_filled", "fully_filled", "in_progress", "completed", "cancelled", "expired"]>>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    page: number;
    status?: "active" | "partially_filled" | "fully_filled" | "in_progress" | "completed" | "cancelled" | "expired" | undefined;
}, {
    limit?: number | undefined;
    status?: "active" | "partially_filled" | "fully_filled" | "in_progress" | "completed" | "cancelled" | "expired" | undefined;
    page?: number | undefined;
}>;
/**
 * Get Order Query Schema
 */
export declare const getOrderQuerySchema: z.ZodObject<{
    orderId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    orderId: string;
}, {
    orderId: string;
}>;
export type TruckSelection = z.infer<typeof truckSelectionSchema>;
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type GetBookingsQuery = z.infer<typeof getBookingsQuerySchema>;
//# sourceMappingURL=booking.schema.d.ts.map