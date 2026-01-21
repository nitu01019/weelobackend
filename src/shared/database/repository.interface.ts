/**
 * =============================================================================
 * REPOSITORY INTERFACE - Database Abstraction Layer
 * =============================================================================
 * 
 * This interface defines the contract for all database operations.
 * Implementations can be:
 *   - JSONRepository (current, for development)
 *   - PostgreSQLRepository (production, AWS RDS)
 *   - MongoDBRepository (alternative)
 * 
 * BENEFITS:
 * - Swap databases without changing business logic
 * - Easy to mock for testing
 * - Consistent API across all data access
 * 
 * SCALABILITY:
 * - Connection pooling handled by implementation
 * - Query optimization per database type
 * - Transaction support where needed
 * =============================================================================
 */

/**
 * Generic query options for all repository methods
 */
export interface QueryOptions {
  /** Maximum number of records to return */
  limit?: number;
  /** Number of records to skip (for pagination) */
  offset?: number;
  /** Field to sort by */
  sortBy?: string;
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
  /** Include soft-deleted records */
  includeDeleted?: boolean;
}

/**
 * Pagination result wrapper
 */
export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasMore: boolean;
  };
}

/**
 * Transaction context for multi-operation consistency
 */
export interface TransactionContext {
  id: string;
  startedAt: Date;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

/**
 * Base entity interface - all records have these fields
 */
export interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Generic Repository Interface
 * All repositories must implement this interface
 */
export interface IRepository<T extends BaseEntity> {
  /**
   * Find a single record by ID
   */
  findById(id: string): Promise<T | null>;

  /**
   * Find a single record matching the filter
   */
  findOne(filter: Partial<T>): Promise<T | null>;

  /**
   * Find all records matching the filter
   */
  findMany(filter: Partial<T>, options?: QueryOptions): Promise<T[]>;

  /**
   * Find all records with pagination
   */
  findPaginated(
    filter: Partial<T>,
    page: number,
    pageSize: number,
    options?: Omit<QueryOptions, 'limit' | 'offset'>
  ): Promise<PaginatedResult<T>>;

  /**
   * Create a new record
   */
  create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T>;

  /**
   * Create multiple records at once (batch insert)
   */
  createMany(data: Array<Omit<T, 'id' | 'createdAt' | 'updatedAt'>>): Promise<T[]>;

  /**
   * Update a record by ID
   */
  update(id: string, data: Partial<Omit<T, 'id' | 'createdAt'>>): Promise<T | null>;

  /**
   * Update multiple records matching the filter
   */
  updateMany(filter: Partial<T>, data: Partial<Omit<T, 'id' | 'createdAt'>>): Promise<number>;

  /**
   * Delete a record by ID (soft delete by default)
   */
  delete(id: string, hard?: boolean): Promise<boolean>;

  /**
   * Delete multiple records matching the filter
   */
  deleteMany(filter: Partial<T>, hard?: boolean): Promise<number>;

  /**
   * Count records matching the filter
   */
  count(filter?: Partial<T>): Promise<number>;

  /**
   * Check if a record exists
   */
  exists(filter: Partial<T>): Promise<boolean>;

  /**
   * Execute raw query (database-specific)
   */
  raw<R = unknown>(query: string, params?: unknown[]): Promise<R>;
}

/**
 * User Repository Interface
 */
export interface IUserRepository extends IRepository<UserEntity> {
  findByPhone(phone: string): Promise<UserEntity | null>;
  findByPhoneAndRole(phone: string, role: string): Promise<UserEntity | null>;
  findDriversByTransporter(transporterId: string): Promise<UserEntity[]>;
  findActiveTransporters(): Promise<UserEntity[]>;
  updateAvailability(id: string, isAvailable: boolean): Promise<UserEntity | null>;
}

/**
 * Vehicle Repository Interface
 */
export interface IVehicleRepository extends IRepository<VehicleEntity> {
  findByTransporter(transporterId: string, options?: QueryOptions): Promise<VehicleEntity[]>;
  findByNumber(vehicleNumber: string): Promise<VehicleEntity | null>;
  findAvailable(transporterId: string): Promise<VehicleEntity[]>;
  findByStatus(status: string, transporterId?: string): Promise<VehicleEntity[]>;
  updateStatus(id: string, status: string, reason?: string): Promise<VehicleEntity | null>;
  assignDriver(vehicleId: string, driverId: string): Promise<VehicleEntity | null>;
  unassignDriver(vehicleId: string): Promise<VehicleEntity | null>;
}

/**
 * Booking Repository Interface
 */
export interface IBookingRepository extends IRepository<BookingEntity> {
  findByCustomer(customerId: string, options?: QueryOptions): Promise<BookingEntity[]>;
  findByTransporter(transporterId: string, options?: QueryOptions): Promise<BookingEntity[]>;
  findByDriver(driverId: string, options?: QueryOptions): Promise<BookingEntity[]>;
  findByStatus(status: string, options?: QueryOptions): Promise<BookingEntity[]>;
  findActiveBookings(): Promise<BookingEntity[]>;
  updateStatus(id: string, status: string): Promise<BookingEntity | null>;
  assignToDriver(id: string, driverId: string, vehicleId: string): Promise<BookingEntity | null>;
}

/**
 * Order Repository Interface (Multi-vehicle orders)
 */
export interface IOrderRepository extends IRepository<OrderEntity> {
  findByCustomer(customerId: string, options?: QueryOptions): Promise<OrderEntity[]>;
  findWithTruckRequests(orderId: string): Promise<OrderWithRequests | null>;
  updateStatus(id: string, status: string): Promise<OrderEntity | null>;
}

/**
 * Tracking Repository Interface
 */
export interface ITrackingRepository extends IRepository<TrackingEntity> {
  findLatestByBooking(bookingId: string): Promise<TrackingEntity | null>;
  findLatestByDriver(driverId: string): Promise<TrackingEntity | null>;
  findHistoryByBooking(bookingId: string, limit?: number): Promise<TrackingEntity[]>;
  createLocation(data: TrackingLocationData): Promise<TrackingEntity>;
}

/**
 * Assignment Repository Interface
 */
export interface IAssignmentRepository extends IRepository<AssignmentEntity> {
  findByBooking(bookingId: string): Promise<AssignmentEntity | null>;
  findByVehicle(vehicleId: string, active?: boolean): Promise<AssignmentEntity[]>;
  findByDriver(driverId: string, active?: boolean): Promise<AssignmentEntity[]>;
  findActiveByTransporter(transporterId: string): Promise<AssignmentEntity[]>;
}

// =============================================================================
// ENTITY DEFINITIONS
// =============================================================================

export interface UserEntity extends BaseEntity {
  phone: string;
  role: 'customer' | 'transporter' | 'driver';
  name: string;
  email?: string;
  profilePhoto?: string;
  company?: string;
  gstNumber?: string;
  businessName?: string;
  businessAddress?: string;
  panNumber?: string;
  transporterId?: string;
  licenseNumber?: string;
  licenseExpiry?: string;
  aadharNumber?: string;
  isVerified: boolean;
  isActive: boolean;
  isAvailable?: boolean;
  fcmToken?: string;
  lastActiveAt?: string;
}

export interface VehicleEntity extends BaseEntity {
  transporterId: string;
  assignedDriverId?: string;
  vehicleNumber: string;
  vehicleType: string;
  vehicleSubtype: string;
  capacity: string;
  model?: string;
  year?: number;
  status: 'available' | 'in_transit' | 'maintenance' | 'inactive';
  currentTripId?: string;
  maintenanceReason?: string;
  maintenanceEndDate?: string;
  lastStatusChange?: string;
  rcNumber?: string;
  rcExpiry?: string;
  insuranceNumber?: string;
  insuranceExpiry?: string;
  permitNumber?: string;
  permitExpiry?: string;
  fitnessExpiry?: string;
  photos?: string[];
}

export interface BookingEntity extends BaseEntity {
  customerId: string;
  transporterId?: string;
  driverId?: string;
  vehicleId?: string;
  status: 'pending' | 'confirmed' | 'assigned' | 'in_transit' | 'completed' | 'cancelled';
  pickup: LocationData;
  dropoff: LocationData;
  vehicleType: string;
  vehicleSubtype?: string;
  scheduledAt?: string;
  fare?: number;
  distance?: number;
  duration?: number;
  notes?: string;
  rating?: number;
  review?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
}

export interface OrderEntity extends BaseEntity {
  customerId: string;
  status: 'draft' | 'pending' | 'partial' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
  pickup: LocationData;
  dropoff: LocationData;
  totalTrucks: number;
  confirmedTrucks: number;
  totalFare?: number;
  notes?: string;
}

export interface OrderWithRequests extends OrderEntity {
  truckRequests: TruckRequestEntity[];
}

export interface TruckRequestEntity extends BaseEntity {
  orderId: string;
  vehicleType: string;
  vehicleSubtype: string;
  quantity: number;
  status: 'pending' | 'broadcasting' | 'partial' | 'fulfilled' | 'cancelled';
  assignedCount: number;
  fare?: number;
}

export interface TrackingEntity extends BaseEntity {
  bookingId: string;
  driverId: string;
  vehicleId: string;
  location: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    heading?: number;
    speed?: number;
  };
  timestamp: string;
  batteryLevel?: number;
  isMoving?: boolean;
}

export interface TrackingLocationData {
  bookingId: string;
  driverId: string;
  vehicleId: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  heading?: number;
  speed?: number;
  batteryLevel?: number;
}

export interface AssignmentEntity extends BaseEntity {
  bookingId: string;
  orderId?: string;
  truckRequestId?: string;
  transporterId: string;
  driverId: string;
  vehicleId: string;
  status: 'pending' | 'accepted' | 'rejected' | 'in_transit' | 'completed' | 'cancelled';
  acceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface LocationData {
  address: string;
  latitude: number;
  longitude: number;
  city?: string;
  state?: string;
  pincode?: string;
  landmark?: string;
}

// =============================================================================
// DATABASE PROVIDER INTERFACE
// =============================================================================

/**
 * Database Provider - Factory for creating repositories
 * Implementations: JSONDatabaseProvider, PostgreSQLDatabaseProvider
 */
export interface IDatabaseProvider {
  /** Initialize the database connection */
  initialize(): Promise<void>;
  
  /** Close all connections */
  close(): Promise<void>;
  
  /** Check if database is connected/healthy */
  isHealthy(): Promise<boolean>;
  
  /** Get connection pool stats */
  getStats(): DatabaseStats;
  
  /** Begin a transaction */
  beginTransaction(): Promise<TransactionContext>;
  
  /** Repository accessors */
  users: IUserRepository;
  vehicles: IVehicleRepository;
  bookings: IBookingRepository;
  orders: IOrderRepository;
  tracking: ITrackingRepository;
  assignments: IAssignmentRepository;
}

export interface DatabaseStats {
  provider: string;
  isConnected: boolean;
  poolSize?: number;
  activeConnections?: number;
  idleConnections?: number;
  waitingRequests?: number;
  totalQueries?: number;
  avgQueryTime?: number;
  // For JSON provider
  dbPath?: string;
  fileSize?: number;
  recordCounts?: {
    users: number;
    vehicles: number;
    bookings: number;
    orders: number;
    tracking: number;
    assignments: number;
  };
}
