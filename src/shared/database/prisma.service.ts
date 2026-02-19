/**
 * =============================================================================
 * PRISMA DATABASE SERVICE - PostgreSQL Database
 * =============================================================================
 * 
 * Production-ready database service using Prisma ORM with PostgreSQL.
 * This replaces the JSON file database while keeping the same API interface.
 * 
 * =============================================================================
 */

import { PrismaClient, UserRole, VehicleStatus, BookingStatus, OrderStatus, TruckRequestStatus, AssignmentStatus } from '@prisma/client';
import { logger } from '../services/logger.service';

// =============================================================================
// PAGINATION SAFETY — Prevents unbounded queries from exhausting memory
// =============================================================================
// All list queries use this as a default limit when no explicit limit is provided.
// Callers can override by passing their own limit, but it's capped at MAX_PAGE_SIZE.
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

// Re-export types for compatibility
export { UserRole, VehicleStatus, BookingStatus, OrderStatus, TruckRequestStatus, AssignmentStatus };

// =============================================================================
// TYPE DEFINITIONS (matching original db.ts interfaces)
// =============================================================================

export interface LocationRecord {
  latitude: number;
  longitude: number;
  address: string;
  city?: string;
  state?: string;
}

export interface RoutePointRecord {
  type: 'PICKUP' | 'STOP' | 'DROP';
  latitude: number;
  longitude: number;
  address: string;
  city?: string;
  state?: string;
  stopIndex: number;
}

export interface StopWaitTimerRecord {
  stopIndex: number;
  arrivedAt: string;
  departedAt?: string;
  waitTimeSeconds: number;
}

export interface UserRecord {
  id: string;
  phone: string;
  role: 'customer' | 'transporter' | 'driver';
  name: string;
  email?: string | null;
  profilePhoto?: string | null;
  company?: string | null;
  gstNumber?: string | null;
  businessName?: string | null;
  businessAddress?: string | null;
  panNumber?: string | null;
  transporterId?: string | null;
  licenseNumber?: string | null;
  licenseExpiry?: string | null;
  aadharNumber?: string | null;
  isVerified: boolean;
  isActive: boolean;
  isAvailable?: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface VehicleRecord {
  id: string;
  transporterId: string;
  assignedDriverId?: string | null;
  vehicleNumber: string;
  vehicleType: string;
  vehicleSubtype: string;
  vehicleKey?: string | null;
  capacity: string;
  model?: string | null;
  year?: number | null;
  status: 'available' | 'in_transit' | 'maintenance' | 'inactive';
  currentTripId?: string | null;
  maintenanceReason?: string | null;
  maintenanceEndDate?: string | null;
  lastStatusChange?: string | null;
  rcNumber?: string | null;
  rcExpiry?: string | null;
  insuranceNumber?: string | null;
  insuranceExpiry?: string | null;
  permitNumber?: string | null;
  permitExpiry?: string | null;
  fitnessExpiry?: string | null;
  vehiclePhotos?: string[];
  rcPhoto?: string | null;
  insurancePhoto?: string | null;
  isVerified: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BookingRecord {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  pickup: LocationRecord;
  drop: LocationRecord;
  vehicleType: string;
  vehicleSubtype: string;
  trucksNeeded: number;
  trucksFilled: number;
  distanceKm: number;
  pricePerTruck: number;
  totalAmount: number;
  goodsType?: string | null;
  weight?: string | null;
  status: 'active' | 'partially_filled' | 'fully_filled' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  notifiedTransporters: string[];
  scheduledAt?: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrderRecord {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  routePoints: RoutePointRecord[];
  currentRouteIndex: number;
  stopWaitTimers: StopWaitTimerRecord[];
  pickup: LocationRecord;
  drop: LocationRecord;
  distanceKm: number;
  totalTrucks: number;
  trucksFilled: number;
  totalAmount: number;
  goodsType?: string | null;
  weight?: string | null;
  cargoWeightKg?: number | null;
  status: 'active' | 'partially_filled' | 'fully_filled' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  scheduledAt?: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TruckRequestRecord {
  id: string;
  orderId: string;
  requestNumber: number;
  vehicleType: string;
  vehicleSubtype: string;
  pricePerTruck: number;
  status: 'searching' | 'held' | 'assigned' | 'accepted' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  heldBy?: string | null;
  heldAt?: string | null;
  assignedTo?: string | null;
  assignedTransporterId?: string | null;
  assignedTransporterName?: string | null;
  assignedVehicleId?: string | null;
  assignedVehicleNumber?: string | null;
  assignedDriverId?: string | null;
  assignedDriverName?: string | null;
  assignedDriverPhone?: string | null;
  tripId?: string | null;
  notifiedTransporters: string[];
  assignedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssignmentRecord {
  id: string;
  bookingId: string;
  truckRequestId?: string | null;
  orderId?: string | null;
  transporterId: string;
  transporterName: string;
  vehicleId: string;
  vehicleNumber: string;
  vehicleType: string;
  vehicleSubtype: string;
  driverId: string;
  driverName: string;
  driverPhone: string;
  tripId: string;
  status: 'pending' | 'driver_accepted' | 'driver_declined' | 'en_route_pickup' | 'at_pickup' | 'in_transit' | 'completed' | 'cancelled';
  assignedAt: string;
  driverAcceptedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface TrackingRecord {
  tripId: string;
  driverId: string;
  vehicleNumber: string;
  bookingId: string;
  latitude: number;
  longitude: number;
  speed: number;
  bearing: number;
  status: string;
  lastUpdated: string;
}

// =============================================================================
// CONNECTION POOL CONFIGURATION
// =============================================================================
// 
// SCALABILITY: Prisma defaults to 2-5 connections — too low for production
// with millions of concurrent users. We configure optimal pool size.
// 
// EASY UNDERSTANDING:
// - connection_limit = max simultaneous DB connections per ECS instance
// - pool_timeout = seconds to wait for a free connection before erroring
// - Configurable via env vars (DB_CONNECTION_LIMIT, DB_POOL_TIMEOUT)
// 
// MODULARITY: Pool config is centralized here, not scattered across services
// 
// FORMULA: For N ECS instances, total connections = N × connection_limit
// RDS default max_connections ≈ 100-400 depending on instance size
// With 4 ECS instances × 20 = 80 connections (safe under RDS limits)
// =============================================================================

const DB_POOL_CONFIG = {
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '20', 10),
  poolTimeout: parseInt(process.env.DB_POOL_TIMEOUT || '10', 10),
};

// Prisma client singleton
let prisma: PrismaClient;

function getPrismaClient(): PrismaClient {
  if (!prisma) {
    // Build pooled DATABASE_URL with connection limits
    const databaseUrl = process.env.DATABASE_URL || '';
    const separator = databaseUrl.includes('?') ? '&' : '?';
    const pooledUrl = `${databaseUrl}${separator}connection_limit=${DB_POOL_CONFIG.connectionLimit}&pool_timeout=${DB_POOL_CONFIG.poolTimeout}`;

    prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' 
        ? ['query', 'error', 'warn'] 
        : ['error', 'warn'],
      datasources: {
        db: {
          url: pooledUrl,
        },
      },
    });

    // =========================================================================
    // SLOW QUERY LOGGING — Detect performance bottlenecks in production
    // =========================================================================
    // Logs any query taking > SLOW_QUERY_THRESHOLD_MS.
    // Uses Prisma $use middleware (runs on every query, ~0.01ms overhead).
    // Threshold configurable via env var (default 200ms — same as pg_stat_statements).
    const SLOW_QUERY_THRESHOLD_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || '200', 10);

    prisma.$use(async (params, next) => {
      const start = Date.now();
      const result = await next(params);
      const durationMs = Date.now() - start;

      if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
        logger.warn(`🐢 [SlowQuery] ${params.model}.${params.action} took ${durationMs}ms (threshold: ${SLOW_QUERY_THRESHOLD_MS}ms)`, {
          model: params.model,
          action: params.action,
          durationMs,
          // Don't log args in production — may contain PII
          ...(process.env.NODE_ENV === 'development' && { args: JSON.stringify(params.args).substring(0, 200) }),
        });
      }

      return result;
    });

    logger.info(`🗄️ Prisma connection pool configured: limit=${DB_POOL_CONFIG.connectionLimit}, timeout=${DB_POOL_CONFIG.poolTimeout}s`);
    logger.info(`🐢 Slow query logging enabled: threshold=${SLOW_QUERY_THRESHOLD_MS}ms`);

    // SCALABILITY: Graceful shutdown - properly close DB connections
    const shutdown = async () => {
      logger.info('Disconnecting Prisma client...');
      await prisma.$disconnect();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
  return prisma;
}

// =============================================================================
// PRISMA DATABASE SERVICE CLASS
// =============================================================================

class PrismaDatabaseService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = getPrismaClient();
    this.connect();
  }

  private async connect() {
    try {
      await this.prisma.$connect();
      logger.info('✅ PostgreSQL connected via Prisma');
    } catch (error) {
      logger.error('❌ PostgreSQL connection failed:', error);
    }
  }

  // Helper: Normalize vehicle strings for matching
  private normalizeVehicleString(str: string): string {
    return str
      .toLowerCase()
      .trim()
      .replace(/feet/gi, 'ft')
      .replace(/foot/gi, 'ft')
      .replace(/ton/gi, 't')
      .replace(/wheeler/gi, 'w')
      .replace(/axle/gi, 'ax')
      .replace(/[\s_-]+/g, '')
      .replace(/\+/g, 'plus');
  }

  private vehicleStringsMatch(str1: string, str2: string): boolean {
    return this.normalizeVehicleString(str1) === this.normalizeVehicleString(str2);
  }

  // Helper: Convert Prisma model to Record type
  private toUserRecord(user: any): UserRecord {
    return {
      ...user,
      role: user.role as 'customer' | 'transporter' | 'driver',
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  private toVehicleRecord(vehicle: any): VehicleRecord {
    return {
      ...vehicle,
      status: vehicle.status as VehicleRecord['status'],
      vehiclePhotos: vehicle.vehiclePhotos || [],
      createdAt: vehicle.createdAt.toISOString(),
      updatedAt: vehicle.updatedAt.toISOString(),
    };
  }

  // Helper to safely parse JSON fields (handles both string and object)
  private parseJsonField<T>(value: any): T {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as T;
      } catch (e) {
        logger.warn('Failed to parse JSON field:', e);
        return value as T;
      }
    }
    return value as T;
  }

  private toBookingRecord(booking: any): BookingRecord {
    return {
      ...booking,
      pickup: this.parseJsonField<LocationRecord>(booking.pickup),
      drop: this.parseJsonField<LocationRecord>(booking.drop),
      status: booking.status as BookingRecord['status'],
      notifiedTransporters: booking.notifiedTransporters || [],
      createdAt: booking.createdAt.toISOString(),
      updatedAt: booking.updatedAt.toISOString(),
    };
  }

  private toOrderRecord(order: any): OrderRecord {
    return {
      ...order,
      routePoints: this.parseJsonField<RoutePointRecord[]>(order.routePoints) || [],
      stopWaitTimers: this.parseJsonField<StopWaitTimerRecord[]>(order.stopWaitTimers) || [],
      pickup: this.parseJsonField<LocationRecord>(order.pickup),
      drop: this.parseJsonField<LocationRecord>(order.drop),
      status: order.status as OrderRecord['status'],
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  }

  private toTruckRequestRecord(request: any): TruckRequestRecord {
    return {
      ...request,
      heldBy: request.heldById,
      assignedTo: request.assignedTransporterId,
      status: request.status as TruckRequestRecord['status'],
      notifiedTransporters: request.notifiedTransporters || [],
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt.toISOString(),
    };
  }

  private toAssignmentRecord(assignment: any): AssignmentRecord {
    return {
      ...assignment,
      bookingId: assignment.bookingId || '',
      status: assignment.status as AssignmentRecord['status'],
    };
  }

  private toTrackingRecord(tracking: any): TrackingRecord {
    return {
      ...tracking,
      bookingId: tracking.bookingId || '',
      lastUpdated: tracking.lastUpdated.toISOString(),
    };
  }

  // ==========================================================================
  // USER OPERATIONS
  // ==========================================================================

  async createUser(user: Omit<UserRecord, 'createdAt' | 'updatedAt'>): Promise<UserRecord> {
    const existing = await this.prisma.user.findFirst({
      where: { phone: user.phone, role: user.role as UserRole }
    });

    if (existing) {
      const updated = await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          ...user,
          role: user.role as UserRole,
        }
      });
      return this.toUserRecord(updated);
    }

    const created = await this.prisma.user.create({
      data: {
        ...user,
        role: user.role as UserRole,
      }
    });
    return this.toUserRecord(created);
  }

  async getUserById(id: string): Promise<UserRecord | undefined> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? this.toUserRecord(user) : undefined;
  }

  async getUserByPhone(phone: string, role: string): Promise<UserRecord | undefined> {
    const user = await this.prisma.user.findFirst({
      where: { phone, role: role as UserRole }
    });
    return user ? this.toUserRecord(user) : undefined;
  }

  async getDriversByTransporter(transporterId: string): Promise<UserRecord[]> {
    const drivers = await this.prisma.user.findMany({
      where: { role: 'driver', transporterId }
    });
    return drivers.map(d => this.toUserRecord(d));
  }

  async updateUser(id: string, updates: Partial<UserRecord>): Promise<UserRecord | undefined> {
    try {
      const { createdAt, updatedAt, ...data } = updates as any;
      const updated = await this.prisma.user.update({
        where: { id },
        data: {
          ...data,
          role: data.role ? data.role as UserRole : undefined,
        }
      });
      return this.toUserRecord(updated);
    } catch {
      return undefined;
    }
  }

  // ==========================================================================
  // VEHICLE OPERATIONS
  // ==========================================================================

  async createVehicle(vehicle: Omit<VehicleRecord, 'createdAt' | 'updatedAt'>): Promise<VehicleRecord> {
    const existing = await this.prisma.vehicle.findUnique({
      where: { vehicleNumber: vehicle.vehicleNumber }
    });

    if (existing) {
      const updated = await this.prisma.vehicle.update({
        where: { id: existing.id },
        data: {
          ...vehicle,
          status: vehicle.status as VehicleStatus,
        }
      });
      logger.info(`Vehicle updated: ${vehicle.vehicleNumber} (${vehicle.vehicleType})`);
      return this.toVehicleRecord(updated);
    }

    const created = await this.prisma.vehicle.create({
      data: {
        ...vehicle,
        status: vehicle.status as VehicleStatus,
      }
    });
    logger.info(`Vehicle registered: ${vehicle.vehicleNumber} (${vehicle.vehicleType})`);
    return this.toVehicleRecord(created);
  }

  async getVehicleById(id: string): Promise<VehicleRecord | undefined> {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });
    return vehicle ? this.toVehicleRecord(vehicle) : undefined;
  }

  async getVehicleByNumber(vehicleNumber: string): Promise<VehicleRecord | undefined> {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { vehicleNumber } });
    return vehicle ? this.toVehicleRecord(vehicle) : undefined;
  }

  async getVehiclesByTransporter(transporterId: string): Promise<VehicleRecord[]> {
    const vehicles = await this.prisma.vehicle.findMany({ where: { transporterId } });
    return vehicles.map(v => this.toVehicleRecord(v));
  }

  async getVehiclesByType(vehicleType: string): Promise<VehicleRecord[]> {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { vehicleType, isActive: true }
    });
    return vehicles.map(v => this.toVehicleRecord(v));
  }

  /**
   * Get transporter IDs that own a specific vehicle type
   * 
   * OPTIMIZATION: Uses vehicleKey WHERE clause when available to leverage
   * the @@index([vehicleKey]) index. Falls back to vehicleType + vehicleSubtype
   * with @@index([vehicleType, vehicleSubtype]) for vehicles without vehicleKey.
   * 
   * BEFORE: Loaded ALL active vehicles, filtered in JS → O(total vehicles)
   * AFTER:  Prisma WHERE clause → O(matching vehicles) with index scan
   * 
   * SCALABILITY: At 1M vehicles, this goes from scanning all 1M to scanning
   * only the ~100-1000 matching ones. ~100x improvement.
   */
  async getTransportersWithVehicleType(vehicleType: string, vehicleSubtype?: string): Promise<string[]> {
    const searchKey = vehicleSubtype
      ? `${this.normalizeVehicleString(vehicleType)}_${this.normalizeVehicleString(vehicleSubtype)}`
      : this.normalizeVehicleString(vehicleType);

    // OPTIMIZATION: Use vehicleKey WHERE clause for indexed lookup
    // Try exact vehicleKey match first (fastest path — uses @@index([vehicleKey]))
    let vehicles = await this.prisma.vehicle.findMany({
      where: {
        isActive: true,
        vehicleKey: vehicleSubtype
          ? searchKey                               // Exact match: "open_17ft"
          : { startsWith: searchKey }               // Prefix match: "open_*"
      },
      select: { transporterId: true }
    });

    // Fallback: If no vehicleKey matches, try vehicleType + vehicleSubtype
    // (for vehicles registered before vehicleKey was introduced)
    if (vehicles.length === 0) {
      const whereClause: any = {
        isActive: true,
        vehicleType: { mode: 'insensitive' as const, equals: vehicleType }
      };
      if (vehicleSubtype) {
        whereClause.vehicleSubtype = { mode: 'insensitive' as const, equals: vehicleSubtype };
      }
      
      vehicles = await this.prisma.vehicle.findMany({
        where: whereClause,
        select: { transporterId: true }
      });
    }

    // Deduplicate transporter IDs
    const result = [...new Set(vehicles.map(v => v.transporterId))];
    logger.info(`Found ${result.length} transporters with ${vehicleType}${vehicleSubtype ? '/' + vehicleSubtype : ''}`);
    return result;
  }

  async updateVehicle(id: string, updates: Partial<VehicleRecord>): Promise<VehicleRecord | undefined> {
    try {
      const { createdAt, updatedAt, ...data } = updates as any;
      const updated = await this.prisma.vehicle.update({
        where: { id },
        data: {
          ...data,
          status: data.status ? data.status as VehicleStatus : undefined,
        }
      });
      return this.toVehicleRecord(updated);
    } catch {
      return undefined;
    }
  }

  async deleteVehicle(id: string): Promise<boolean> {
    try {
      await this.prisma.vehicle.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // BOOKING OPERATIONS
  // ==========================================================================

  async createBooking(booking: Omit<BookingRecord, 'createdAt' | 'updatedAt'>): Promise<BookingRecord> {
    const created = await this.prisma.booking.create({
      data: {
        ...booking,
        pickup: booking.pickup as any,
        drop: booking.drop as any,
        status: booking.status as BookingStatus,
      }
    });
    logger.info(`Booking created: ${booking.id} (${booking.vehicleType}, ${booking.trucksNeeded} trucks)`);
    return this.toBookingRecord(created);
  }

  async getBookingById(id: string): Promise<BookingRecord | undefined> {
    const booking = await this.prisma.booking.findUnique({ where: { id } });
    return booking ? this.toBookingRecord(booking) : undefined;
  }

  async getBookingsByCustomer(customerId: string, limit: number = DEFAULT_PAGE_SIZE): Promise<BookingRecord[]> {
    const bookings = await this.prisma.booking.findMany({
      where: { customerId },
      take: Math.min(limit, MAX_PAGE_SIZE),
      orderBy: { createdAt: 'desc' }
    });
    return bookings.map(b => this.toBookingRecord(b));
  }

  async getBookingsByDriver(driverId: string): Promise<BookingRecord[]> {
    const assignments = await this.prisma.assignment.findMany({
      where: { driverId },
      select: { bookingId: true }
    });
    const bookingIds = assignments.map(a => a.bookingId).filter(Boolean) as string[];
    
    const bookings = await this.prisma.booking.findMany({
      where: { id: { in: bookingIds } }
    });
    return bookings.map(b => this.toBookingRecord(b));
  }

  async getActiveBookingsForTransporter(transporterId: string): Promise<BookingRecord[]> {
    const vehicles = await this.getVehiclesByTransporter(transporterId);
    const vehicleTypes = [...new Set(vehicles.map(v => v.vehicleType))];

    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ['active', 'partially_filled'] },
        vehicleType: { in: vehicleTypes }
      }
    });
    return bookings.map(b => this.toBookingRecord(b));
  }

  async updateBooking(id: string, updates: Partial<BookingRecord>): Promise<BookingRecord | undefined> {
    try {
      const { createdAt, updatedAt, ...data } = updates as any;
      const updated = await this.prisma.booking.update({
        where: { id },
        data: {
          ...data,
          pickup: data.pickup ? data.pickup as any : undefined,
          drop: data.drop ? data.drop as any : undefined,
          status: data.status ? data.status as BookingStatus : undefined,
        }
      });
      return this.toBookingRecord(updated);
    } catch {
      return undefined;
    }
  }

  // ==========================================================================
  // ORDER OPERATIONS
  // ==========================================================================

  async createOrder(order: Omit<OrderRecord, 'createdAt' | 'updatedAt'>): Promise<OrderRecord> {
    const created = await this.prisma.order.create({
      data: {
        ...order,
        routePoints: order.routePoints as any,
        stopWaitTimers: order.stopWaitTimers as any,
        pickup: order.pickup as any,
        drop: order.drop as any,
        status: order.status as OrderStatus,
      }
    });
    logger.info(`Order created: ${order.id} (${order.totalTrucks} trucks)`);
    return this.toOrderRecord(created);
  }

  async getOrderById(id: string): Promise<OrderRecord | undefined> {
    const order = await this.prisma.order.findUnique({ where: { id } });
    return order ? this.toOrderRecord(order) : undefined;
  }

  async getOrdersByCustomer(customerId: string, limit: number = DEFAULT_PAGE_SIZE): Promise<OrderRecord[]> {
    const orders = await this.prisma.order.findMany({
      where: { customerId },
      take: Math.min(limit, MAX_PAGE_SIZE),
      orderBy: { createdAt: 'desc' }
    });
    return orders.map(o => this.toOrderRecord(o));
  }

  /**
   * SCALABILITY: Efficient query with proper indexing
   * EASY UNDERSTANDING: Gets active order, auto-expires old ones
   * MODULARITY: Handles expiry logic in one place
   * 
   * CRITICAL FIX: Directly query with expiresAt > now to avoid timezone issues
   */
  async getActiveOrderByCustomer(customerId: string): Promise<OrderRecord | undefined> {
    const now = new Date();
    
    logger.info(`🔍 [getActiveOrderByCustomer] Checking for active order for customer: ${customerId}`);
    logger.info(`🕐 [getActiveOrderByCustomer] Current time: ${now.toISOString()}`);
    
    // CRITICAL FIX: Query expired orders separately and update them first
    const expiredOrders = await this.prisma.order.findMany({
      where: {
        customerId,
        status: { notIn: ['cancelled', 'completed', 'fully_filled', 'expired'] },
        expiresAt: { lte: now.toISOString() } // Orders that have expired
      }
    });
    
    // Auto-expire any found expired orders
    if (expiredOrders.length > 0) {
      logger.info(`🔄 [getActiveOrderByCustomer] Found ${expiredOrders.length} expired orders, updating...`);
      
      for (const expiredOrder of expiredOrders) {
        logger.info(`   Expiring order: ${expiredOrder.id} (expired at: ${expiredOrder.expiresAt})`);
        
        // Update order status to expired
        await this.prisma.order.update({
          where: { id: expiredOrder.id },
          data: { status: 'expired' }
        });
        
        // Expire all unfilled truck requests
        await this.prisma.truckRequest.updateMany({
          where: {
            orderId: expiredOrder.id,
            status: { in: ['searching', 'held'] }
          },
          data: { status: 'expired' }
        });
      }
      
      logger.info(`✅ [getActiveOrderByCustomer] Expired ${expiredOrders.length} orders`);
    }
    
    // Now find truly active orders (not expired, not cancelled, not completed)
    const activeOrder = await this.prisma.order.findFirst({
      where: {
        customerId,
        status: { notIn: ['cancelled', 'completed', 'fully_filled', 'expired'] },
        expiresAt: { gt: now.toISOString() } // CRITICAL: Only orders that haven't expired yet
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    if (!activeOrder) {
      logger.info(`✅ [getActiveOrderByCustomer] No active order found for customer: ${customerId}`);
      return undefined;
    }
    
    logger.warn(`⚠️  [getActiveOrderByCustomer] Active order found: ${activeOrder.id}, expires at: ${activeOrder.expiresAt}`);
    return this.toOrderRecord(activeOrder);
  }

  async updateOrder(id: string, updates: Partial<OrderRecord>): Promise<OrderRecord | undefined> {
    try {
      const { createdAt, updatedAt, ...data } = updates as any;
      const updated = await this.prisma.order.update({
        where: { id },
        data: {
          ...data,
          routePoints: data.routePoints ? data.routePoints as any : undefined,
          stopWaitTimers: data.stopWaitTimers ? data.stopWaitTimers as any : undefined,
          pickup: data.pickup ? data.pickup as any : undefined,
          drop: data.drop ? data.drop as any : undefined,
          status: data.status ? data.status as OrderStatus : undefined,
        }
      });
      return this.toOrderRecord(updated);
    } catch {
      return undefined;
    }
  }

  async getActiveOrders(): Promise<OrderRecord[]> {
    const now = new Date();
    const orders = await this.prisma.order.findMany({
      where: {
        status: { notIn: ['fully_filled', 'completed', 'cancelled'] },
        expiresAt: { gt: now.toISOString() }
      }
    });
    
    return orders
      .map(o => this.toOrderRecord(o))
      .filter(o => o.trucksFilled < o.totalTrucks);
  }

  // ==========================================================================
  // TRUCK REQUEST OPERATIONS
  // ==========================================================================

  async createTruckRequest(request: Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'>): Promise<TruckRequestRecord> {
    const created = await this.prisma.truckRequest.create({
      data: {
        id: request.id,
        orderId: request.orderId,
        requestNumber: request.requestNumber,
        vehicleType: request.vehicleType,
        vehicleSubtype: request.vehicleSubtype,
        pricePerTruck: request.pricePerTruck,
        status: request.status as TruckRequestStatus,
        heldById: request.heldBy || null,
        heldAt: request.heldAt || null,
        assignedTransporterId: request.assignedTransporterId || request.assignedTo || null,
        assignedTransporterName: request.assignedTransporterName || null,
        assignedVehicleId: request.assignedVehicleId || null,
        assignedVehicleNumber: request.assignedVehicleNumber || null,
        assignedDriverId: request.assignedDriverId || null,
        assignedDriverName: request.assignedDriverName || null,
        assignedDriverPhone: request.assignedDriverPhone || null,
        tripId: request.tripId || null,
        notifiedTransporters: request.notifiedTransporters || [],
        assignedAt: request.assignedAt || null,
      }
    });
    logger.info(`TruckRequest created: ${request.id} (${request.vehicleType} ${request.vehicleSubtype})`);
    return this.toTruckRequestRecord(created);
  }

  /**
   * Batch create truck requests in a SINGLE database round-trip
   * 
   * OPTIMIZATION: Uses prisma.truckRequest.createMany() for single INSERT
   * instead of N individual createTruckRequest() calls.
   * 
   * BEFORE: N round-trips to DB (one per request) → O(N) latency
   * AFTER:  1 round-trip (batch INSERT) + 1 fetch → O(1) latency
   * 
   * SCALABILITY: For an order with 10 trucks, this goes from 10 DB calls
   * to 2 DB calls. At millions of concurrent orders, this is significant.
   */
  async createTruckRequestsBatch(requests: Omit<TruckRequestRecord, 'createdAt' | 'updatedAt'>[]): Promise<TruckRequestRecord[]> {
    if (requests.length === 0) return [];
    
    // Batch INSERT — single round-trip
    await this.prisma.truckRequest.createMany({
      data: requests.map(request => ({
        id: request.id,
        orderId: request.orderId,
        requestNumber: request.requestNumber,
        vehicleType: request.vehicleType,
        vehicleSubtype: request.vehicleSubtype,
        pricePerTruck: request.pricePerTruck,
        status: request.status as TruckRequestStatus,
        heldById: request.heldBy || null,
        heldAt: request.heldAt || null,
        assignedTransporterId: request.assignedTransporterId || request.assignedTo || null,
        assignedTransporterName: request.assignedTransporterName || null,
        assignedVehicleId: request.assignedVehicleId || null,
        assignedVehicleNumber: request.assignedVehicleNumber || null,
        assignedDriverId: request.assignedDriverId || null,
        assignedDriverName: request.assignedDriverName || null,
        assignedDriverPhone: request.assignedDriverPhone || null,
        tripId: request.tripId || null,
        notifiedTransporters: request.notifiedTransporters || [],
        assignedAt: request.assignedAt || null,
      })),
      skipDuplicates: true,
    });
    
    // Fetch the created records (createMany doesn't return them)
    const ids = requests.map(r => r.id);
    const created = await this.prisma.truckRequest.findMany({
      where: { id: { in: ids } }
    });
    
    logger.info(`TruckRequests batch created: ${created.length} requests (single round-trip)`);
    return created.map(r => this.toTruckRequestRecord(r));
  }

  async getTruckRequestById(id: string): Promise<TruckRequestRecord | undefined> {
    const request = await this.prisma.truckRequest.findUnique({ where: { id } });
    return request ? this.toTruckRequestRecord(request) : undefined;
  }

  async getTruckRequestsByOrder(orderId: string): Promise<TruckRequestRecord[]> {
    const requests = await this.prisma.truckRequest.findMany({ where: { orderId } });
    return requests.map(r => this.toTruckRequestRecord(r));
  }

  async getActiveTruckRequestsForTransporter(transporterId: string): Promise<TruckRequestRecord[]> {
    const vehicles = await this.getVehiclesByTransporter(transporterId);
    const vehicleKeys = new Set(
      vehicles
        .filter(v => v.isActive)
        .map(v => `${this.normalizeVehicleString(v.vehicleType)}_${this.normalizeVehicleString(v.vehicleSubtype)}`)
    );

    const requests = await this.prisma.truckRequest.findMany({
      where: { status: 'searching' }
    });

    return requests
      .filter(r => {
        const requestKey = `${this.normalizeVehicleString(r.vehicleType)}_${this.normalizeVehicleString(r.vehicleSubtype)}`;
        return vehicleKeys.has(requestKey);
      })
      .map(r => this.toTruckRequestRecord(r));
  }

  async getTruckRequestsByVehicleType(vehicleType: string, vehicleSubtype?: string): Promise<TruckRequestRecord[]> {
    const requests = await this.prisma.truckRequest.findMany({
      where: { status: 'searching' }
    });

    return requests
      .filter(r => {
        if (!this.vehicleStringsMatch(r.vehicleType, vehicleType)) return false;
        if (vehicleSubtype && !this.vehicleStringsMatch(r.vehicleSubtype, vehicleSubtype)) return false;
        return true;
      })
      .map(r => this.toTruckRequestRecord(r));
  }

  async updateTruckRequest(id: string, updates: Partial<TruckRequestRecord>): Promise<TruckRequestRecord | undefined> {
    try {
      const { createdAt, updatedAt, heldBy, assignedTo, ...data } = updates as any;
      const updated = await this.prisma.truckRequest.update({
        where: { id },
        data: {
          ...data,
          heldById: heldBy !== undefined ? heldBy : data.heldById,
          assignedTransporterId: assignedTo !== undefined ? assignedTo : data.assignedTransporterId,
          status: data.status ? data.status as TruckRequestStatus : undefined,
        }
      });
      return this.toTruckRequestRecord(updated);
    } catch {
      return undefined;
    }
  }

  /**
   * Batch update truck requests in a SINGLE database round-trip
   * 
   * OPTIMIZATION: Uses prisma.truckRequest.updateMany() for single UPDATE
   * instead of N individual updateTruckRequest() calls.
   * 
   * BEFORE: N round-trips to DB (one per ID) → O(N) latency
   * AFTER:  1 round-trip (batch UPDATE WHERE id IN [...]) → O(1) latency
   * 
   * SCALABILITY: For expiring 50 requests at once, this goes from
   * 50 DB calls to 1 DB call.
   */
  async updateTruckRequestsBatch(ids: string[], updates: Partial<TruckRequestRecord>): Promise<number> {
    if (ids.length === 0) return 0;
    
    // Build Prisma-compatible update data
    const { createdAt, updatedAt, heldBy, assignedTo, ...data } = updates as any;
    const prismaData: any = { ...data };
    
    // Map legacy field names to Prisma field names
    if (heldBy !== undefined) prismaData.heldById = heldBy;
    if (assignedTo !== undefined) prismaData.assignedTransporterId = assignedTo;
    if (prismaData.status) prismaData.status = prismaData.status as TruckRequestStatus;
    
    const result = await this.prisma.truckRequest.updateMany({
      where: { id: { in: ids } },
      data: prismaData,
    });
    
    return result.count;
  }

  // ==========================================================================
  // ASSIGNMENT OPERATIONS
  // ==========================================================================

  async createAssignment(assignment: AssignmentRecord): Promise<AssignmentRecord> {
    const created = await this.prisma.assignment.create({
      data: {
        ...assignment,
        status: assignment.status as AssignmentStatus,
      }
    });
    logger.info(`Assignment created: ${assignment.id} for booking ${assignment.bookingId}`);
    return this.toAssignmentRecord(created);
  }

  async getAssignmentById(id: string): Promise<AssignmentRecord | undefined> {
    const assignment = await this.prisma.assignment.findUnique({ where: { id } });
    return assignment ? this.toAssignmentRecord(assignment) : undefined;
  }

  async getAssignmentsByBooking(bookingId: string): Promise<AssignmentRecord[]> {
    const assignments = await this.prisma.assignment.findMany({ where: { bookingId } });
    return assignments.map(a => this.toAssignmentRecord(a));
  }

  async getAssignmentsByDriver(driverId: string, limit: number = DEFAULT_PAGE_SIZE): Promise<AssignmentRecord[]> {
    const assignments = await this.prisma.assignment.findMany({
      where: { driverId },
      take: Math.min(limit, MAX_PAGE_SIZE),
      orderBy: { assignedAt: 'desc' }
    });
    return assignments.map(a => this.toAssignmentRecord(a));
  }

  async getAssignmentsByTransporter(transporterId: string, limit: number = DEFAULT_PAGE_SIZE): Promise<AssignmentRecord[]> {
    const assignments = await this.prisma.assignment.findMany({
      where: { transporterId },
      take: Math.min(limit, MAX_PAGE_SIZE),
      orderBy: { assignedAt: 'desc' }
    });
    return assignments.map(a => this.toAssignmentRecord(a));
  }

  async getActiveAssignmentByDriver(driverId: string): Promise<AssignmentRecord | undefined> {
    const activeStatuses: AssignmentStatus[] = ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'];
    const assignment = await this.prisma.assignment.findFirst({
      where: {
        driverId,
        status: { in: activeStatuses }
      }
    });
    return assignment ? this.toAssignmentRecord(assignment) : undefined;
  }

  async updateAssignment(id: string, updates: Partial<AssignmentRecord>): Promise<AssignmentRecord | undefined> {
    try {
      const updated = await this.prisma.assignment.update({
        where: { id },
        data: {
          ...updates,
          status: updates.status ? updates.status as AssignmentStatus : undefined,
        }
      });
      return this.toAssignmentRecord(updated);
    } catch {
      return undefined;
    }
  }

  // ==========================================================================
  // TRACKING OPERATIONS
  // ==========================================================================

  async updateTracking(tracking: TrackingRecord): Promise<void> {
    await this.prisma.tracking.upsert({
      where: { tripId: tracking.tripId },
      update: {
        latitude: tracking.latitude,
        longitude: tracking.longitude,
        speed: tracking.speed,
        bearing: tracking.bearing,
        status: tracking.status,
        lastUpdated: new Date(),
      },
      create: {
        tripId: tracking.tripId,
        driverId: tracking.driverId,
        vehicleNumber: tracking.vehicleNumber,
        bookingId: tracking.bookingId || null,
        latitude: tracking.latitude,
        longitude: tracking.longitude,
        speed: tracking.speed,
        bearing: tracking.bearing,
        status: tracking.status,
      }
    });
  }

  async getTrackingByTrip(tripId: string): Promise<TrackingRecord | undefined> {
    const tracking = await this.prisma.tracking.findUnique({ where: { tripId } });
    return tracking ? this.toTrackingRecord(tracking) : undefined;
  }

  async getTrackingByBooking(bookingId: string): Promise<TrackingRecord[]> {
    const trackings = await this.prisma.tracking.findMany({ where: { bookingId } });
    return trackings.map(t => this.toTrackingRecord(t));
  }

  // ==========================================================================
  // TRANSPORTER AVAILABILITY
  // ==========================================================================

  async getTransporterAvailableTrucks(
    transporterId: string,
    vehicleType: string,
    vehicleSubtype?: string
  ): Promise<{ totalOwned: number; available: number; inTransit: number; maintenance: number }> {
    const vehicles = await this.getVehiclesByTransporter(transporterId);
    
    const matchingVehicles = vehicles.filter(v => {
      if (!v.isActive) return false;
      if (!this.vehicleStringsMatch(v.vehicleType, vehicleType)) return false;
      if (vehicleSubtype && !this.vehicleStringsMatch(v.vehicleSubtype, vehicleSubtype)) return false;
      return true;
    });

    return {
      totalOwned: matchingVehicles.length,
      available: matchingVehicles.filter(v => v.status === 'available').length,
      inTransit: matchingVehicles.filter(v => v.status === 'in_transit').length,
      maintenance: matchingVehicles.filter(v => v.status === 'maintenance').length,
    };
  }

  /**
   * Get availability snapshot for all transporters with a specific vehicle type
   * 
   * OPTIMIZATION #1: Uses vehicleType/vehicleSubtype WHERE clause instead of
   * loading ALL active vehicles. Leverages @@index([vehicleType, vehicleSubtype]).
   * 
   * OPTIMIZATION #2: Batch fetches transporter names in a SINGLE query using
   * prisma.user.findMany({ where: { id: { in: [...] } } }) instead of N
   * individual getUserById() calls (N+1 query problem).
   * 
   * BEFORE: Load ALL vehicles + N getUserById() calls → O(total vehicles + N)
   * AFTER:  Load matching vehicles + 1 batch user fetch → O(matching + 1)
   * 
   * SCALABILITY: At 1M vehicles and 10K transporters, this goes from
   * scanning 1M + 10K queries to scanning ~1K + 1 query.
   */
  async getTransportersAvailabilitySnapshot(
    vehicleType: string,
    vehicleSubtype?: string
  ): Promise<Array<{ transporterId: string; transporterName: string; totalOwned: number; available: number; inTransit: number }>> {
    // OPTIMIZATION: Filter at DB level using indexes
    const normalizedKey = vehicleSubtype
      ? `${this.normalizeVehicleString(vehicleType)}_${this.normalizeVehicleString(vehicleSubtype)}`
      : null;
    
    // Try vehicleKey first (indexed), fallback to type+subtype
    let matchingVehicles;
    if (normalizedKey) {
      matchingVehicles = await this.prisma.vehicle.findMany({
        where: {
          isActive: true,
          OR: [
            { vehicleKey: normalizedKey },
            { vehicleType: { mode: 'insensitive' as const, equals: vehicleType }, 
              vehicleSubtype: { mode: 'insensitive' as const, equals: vehicleSubtype! } }
          ]
        },
        select: { transporterId: true, status: true }
      });
    } else {
      matchingVehicles = await this.prisma.vehicle.findMany({
        where: {
          isActive: true,
          vehicleType: { mode: 'insensitive' as const, equals: vehicleType }
        },
        select: { transporterId: true, status: true }
      });
    }

    // Group by transporter
    const transporterMap = new Map<string, { available: number; inTransit: number; total: number }>();
    
    for (const vehicle of matchingVehicles) {
      if (!transporterMap.has(vehicle.transporterId)) {
        transporterMap.set(vehicle.transporterId, { available: 0, inTransit: 0, total: 0 });
      }
      const stats = transporterMap.get(vehicle.transporterId)!;
      stats.total++;
      if (vehicle.status === 'available') stats.available++;
      if (vehicle.status === 'in_transit') stats.inTransit++;
    }

    // OPTIMIZATION: Batch fetch ALL transporter names in ONE query (fixes N+1)
    const transporterIds = Array.from(transporterMap.keys());
    const transporters = await this.prisma.user.findMany({
      where: { id: { in: transporterIds } },
      select: { id: true, name: true, businessName: true }
    });
    
    // Create name lookup map
    const nameMap = new Map(
      transporters.map(t => [t.id, t.businessName || t.name || 'Unknown'])
    );

    // Build result
    const result: Array<{ transporterId: string; transporterName: string; totalOwned: number; available: number; inTransit: number }> = [];

    for (const [transporterId, stats] of transporterMap) {
      result.push({
        transporterId,
        transporterName: nameMap.get(transporterId) || 'Unknown',
        totalOwned: stats.total,
        available: stats.available,
        inTransit: stats.inTransit,
      });
    }

    return result.filter(t => t.available > 0);
  }

  // ==========================================================================
  // UTILITY
  // ==========================================================================

  async getStats() {
    const [users, vehicles, bookings, assignments] = await Promise.all([
      this.prisma.user.findMany(),
      this.prisma.vehicle.findMany(),
      this.prisma.booking.findMany(),
      this.prisma.assignment.findMany(),
    ]);

    return {
      users: users.length,
      customers: users.filter(u => u.role === 'customer').length,
      transporters: users.filter(u => u.role === 'transporter').length,
      drivers: users.filter(u => u.role === 'driver').length,
      vehicles: vehicles.length,
      activeVehicles: vehicles.filter(v => v.isActive).length,
      bookings: bookings.length,
      activeBookings: bookings.filter(b => b.status === 'active').length,
      assignments: assignments.length,
      dbType: 'PostgreSQL (Prisma)',
    };
  }

  async getRawData() {
    const [users, vehicles, bookings, orders, truckRequests, assignments, tracking] = await Promise.all([
      this.prisma.user.findMany(),
      this.prisma.vehicle.findMany(),
      this.prisma.booking.findMany(),
      this.prisma.order.findMany(),
      this.prisma.truckRequest.findMany(),
      this.prisma.assignment.findMany(),
      this.prisma.tracking.findMany(),
    ]);

    return {
      users: users.map(u => this.toUserRecord(u)),
      vehicles: vehicles.map(v => this.toVehicleRecord(v)),
      bookings: bookings.map(b => this.toBookingRecord(b)),
      orders: orders.map(o => this.toOrderRecord(o)),
      truckRequests: truckRequests.map(r => this.toTruckRequestRecord(r)),
      assignments: assignments.map(a => this.toAssignmentRecord(a)),
      tracking: tracking.map(t => this.toTrackingRecord(t)),
      _meta: {
        version: '2.0.0',
        lastUpdated: new Date().toISOString(),
      }
    };
  }
}

// Export singleton instance
export const prismaDb = new PrismaDatabaseService();

// Export Prisma client for direct access
export const prismaClient = getPrismaClient();
