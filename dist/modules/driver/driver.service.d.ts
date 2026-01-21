/**
 * =============================================================================
 * DRIVER MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for driver operations.
 * =============================================================================
 */
import { UserRecord } from '../../shared/database/db';
import { CreateDriverInput } from './driver.schema';
interface DashboardData {
    stats: {
        totalTrips: number;
        completedToday: number;
        totalEarnings: number;
        todayEarnings: number;
        rating: number;
        acceptanceRate: number;
    };
    recentTrips: any[];
    availability: {
        isOnline: boolean;
        lastOnline: string | null;
    };
}
interface AvailabilityData {
    isOnline: boolean;
    currentLocation?: {
        latitude: number;
        longitude: number;
    };
    lastUpdated: string;
}
interface EarningsData {
    period: string;
    totalEarnings: number;
    tripCount: number;
    avgPerTrip: number;
    breakdown: {
        date: string;
        amount: number;
        trips: number;
    }[];
}
declare class DriverService {
    /**
     * Create a new driver under a transporter
     */
    createDriver(transporterId: string, data: CreateDriverInput): Promise<UserRecord>;
    /**
     * Get all drivers for a transporter with stats
     */
    getTransporterDrivers(transporterId: string): Promise<{
        drivers: UserRecord[];
        total: number;
        available: number;
        onTrip: number;
    }>;
    /**
     * Get driver dashboard data
     */
    getDashboard(userId: string): Promise<DashboardData>;
    /**
     * Get driver availability status
     */
    getAvailability(_userId: string): Promise<AvailabilityData>;
    /**
     * Update driver availability
     */
    updateAvailability(_userId: string, data: {
        isOnline?: boolean;
        currentLocation?: {
            latitude: number;
            longitude: number;
        };
    }): Promise<AvailabilityData>;
    /**
     * Get driver earnings
     */
    getEarnings(userId: string, period?: string): Promise<EarningsData>;
    /**
     * Get driver trips
     */
    getTrips(userId: string, options: {
        status?: string;
        limit: number;
        offset: number;
    }): Promise<{
        trips: {
            id: string;
            pickup: string;
            dropoff: string;
            price: number;
            status: "active" | "partially_filled" | "fully_filled" | "in_progress" | "completed" | "cancelled" | "expired";
            date: string;
            customer: string;
        }[];
        total: number;
        hasMore: boolean;
    }>;
    /**
     * Get active trip for driver
     */
    getActiveTrip(userId: string): Promise<{
        id: string;
        status: "active" | "partially_filled" | "fully_filled" | "in_progress" | "completed" | "cancelled" | "expired";
        pickup: {
            address: string;
            location: {
                lat: number;
                lng: number;
            };
        };
        dropoff: {
            address: string;
            location: {
                lat: number;
                lng: number;
            };
        };
        price: number;
        customer: {
            name: string;
            phone: string;
        };
        createdAt: string;
    } | null>;
}
export declare const driverService: DriverService;
export {};
//# sourceMappingURL=driver.service.d.ts.map