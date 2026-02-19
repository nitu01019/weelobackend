import { z } from 'zod';

// =============================================================================
// RATING VALIDATION SCHEMAS
// =============================================================================

// Predefined rating tags (positive + negative)
export const VALID_RATING_TAGS = [
  'polite', 'on_time', 'safe_driving', 'good_vehicle_condition',
  'professional', 'helpful', 'rude', 'late', 'rash_driving'
] as const;

/**
 * Sanitize user input: strip HTML tags, trim whitespace.
 * Prevents XSS when comment is displayed in driver's Captain app.
 */
function sanitizeComment(input: string): string {
  return input
    .replace(/<[^>]*>/g, '')      // Strip HTML tags
    .replace(/[<>]/g, '')         // Remove any remaining angle brackets
    .trim();
}

/**
 * Submit a rating for a completed trip assignment.
 */
export const submitRatingSchema = z.object({
  assignmentId: z.string().uuid('Invalid assignment ID'),
  stars: z.number().int().min(1, 'Minimum 1 star').max(5, 'Maximum 5 stars'),
  comment: z.string()
    .max(500, 'Comment must be 500 characters or less')
    .transform(sanitizeComment)
    .optional()
    .nullable(),
  tags: z.array(z.enum(VALID_RATING_TAGS))
    .max(5, 'Maximum 5 tags allowed')  // Prevent tag spam
    .optional()
    .default([])
});

export type SubmitRatingInput = z.infer<typeof submitRatingSchema>;

/**
 * Query params for driver's rating history.
 */
export const driverRatingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

export type DriverRatingsQuery = z.infer<typeof driverRatingsQuerySchema>;
