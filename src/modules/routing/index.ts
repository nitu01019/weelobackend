/**
 * =============================================================================
 * ROUTING MODULE
 * =============================================================================
 * 
 * Handles route calculations including:
 * - Distance between points (Haversine formula)
 * - ETA per leg (based on average speed)
 * - Route leg breakdown
 * 
 * SCALABILITY:
 * - All calculations are O(n) where n = number of route points (max 4)
 * - No external API calls (instant response)
 * - CPU-bound only, easily horizontally scalable
 * - Can be enhanced with Google Maps API for real road distances later
 * 
 * MODULARITY:
 * - Pure functions, no side effects
 * - Easy to test
 * - Can swap calculation method without changing interface
 * =============================================================================
 */

export * from './routing.service';
export * from './routing.schema';
