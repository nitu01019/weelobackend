/**
 * =============================================================================
 * DRIVER MODULE - SHARED TYPES
 * =============================================================================
 *
 * Interfaces used across driver sub-services.
 * =============================================================================
 */

export interface TripSummary {
  id: string;
  pickup: string;
  dropoff: string;
  price: number | undefined;
  date: string | undefined;
  status: string;
}

export interface DashboardData {
  stats: {
    totalTrips: number;
    completedToday: number;
    totalEarnings: number;
    todayEarnings: number;
    rating: number;
    totalRatings: number;
    acceptanceRate: number;
    onTimeDeliveryRate: number;
    totalDistance: number;
    todayDistance: number;
  };
  recentTrips: TripSummary[];
  availability: {
    isOnline: boolean;
    lastOnline: string | null;
  };
}

export interface AvailabilityData {
  isOnline: boolean;
  currentLocation?: {
    latitude: number;
    longitude: number;
  };
  lastUpdated: string;
}

export interface EarningsData {
  period: string;
  totalEarnings: number;
  totalTrips: number;
  averagePerTrip: number;
  /** @deprecated Use totalTrips */
  tripCount: number;
  /** @deprecated Use averagePerTrip */
  avgPerTrip: number;
  breakdown: {
    date: string;
    earnings: number;  // Captain app field name
    amount: number;    // Backward compat
    trips: number;
    distance: number;  // Captain app expects this
  }[];
}

/**
 * Performance metrics returned by GET /api/v1/driver/performance
 *
 * Matches Captain app's PerformanceResponseData exactly:
 *   rating, totalRatings, acceptanceRate, onTimeDeliveryRate,
 *   completionRate, totalTrips, totalDistance
 */
export interface PerformanceData {
  rating: number;
  totalRatings: number;
  acceptanceRate: number;
  onTimeDeliveryRate: number;
  completionRate: number;
  totalTrips: number;
  totalDistance: number;
}
