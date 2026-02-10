/**
 * =============================================================================
 * CUSTOM BOOKING MODULE - SCHEMA (Validation)
 * =============================================================================
 * 
 * Zod schemas for request validation.
 * Ensures data integrity for custom booking requests.
 * =============================================================================
 */

import { z } from 'zod';

// Vehicle requirement item
const vehicleRequirementSchema = z.object({
    type: z.string().min(1, 'Vehicle type is required'),
    subtype: z.string().min(1, 'Vehicle subtype is required'),
    quantity: z.number().int().min(1, 'Quantity must be at least 1').max(100, 'Maximum 100 per type')
});

// Create custom booking request
export const createCustomBookingSchema = z.object({
    body: z.object({
        pickupCity: z.string().min(1, 'Pickup city is required'),
        pickupState: z.string().optional(),
        dropCity: z.string().min(1, 'Drop city is required'),
        dropState: z.string().optional(),
        additionalInfo: z.string().optional(),
        vehicleRequirements: z.array(vehicleRequirementSchema)
            .min(1, 'At least one vehicle requirement is needed')
            .max(20, 'Maximum 20 different vehicle types'),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format'),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format'),
        isFlexible: z.boolean().optional(),
        goodsType: z.string().optional(),
        estimatedWeight: z.string().optional(),
        specialRequests: z.string().max(1000, 'Maximum 1000 characters').optional(),
        companyName: z.string().optional(),
        customerEmail: z.string().email().optional()
    }).refine(data => {
        const start = new Date(data.startDate);
        const end = new Date(data.endDate);
        return end > start;
    }, {
        message: 'End date must be after start date',
        path: ['endDate']
    })
});

// Query params for list
export const getRequestsQuerySchema = z.object({
    page: z.string().regex(/^\d+$/).transform(Number).optional(),
    limit: z.string().regex(/^\d+$/).transform(Number).optional()
});

// Cancel request
export const cancelRequestSchema = z.object({
    params: z.object({
        id: z.string().uuid('Invalid request ID')
    })
});

export type CreateCustomBookingInput = z.infer<typeof createCustomBookingSchema>['body'];
