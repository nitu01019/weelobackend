/**
 * =============================================================================
 * RECORD TYPES — All Record interfaces + Prisma enum re-exports
 * =============================================================================
 * Extracted from prisma.service.ts for modularity.
 * =============================================================================
 */

export { UserRole, VehicleStatus, BookingStatus, OrderStatus, TruckRequestStatus, AssignmentStatus, HoldPhase, TimeoutExtensionType } from '@prisma/client';

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
  status: 'available' | 'on_hold' | 'in_transit' | 'maintenance' | 'inactive';
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
  dispatchState?: 'queued' | 'dispatching' | 'dispatched' | 'dispatch_failed';
  dispatchAttempts?: number;
  dispatchReasonCode?: string | null;
  onlineCandidatesCount?: number;
  notifiedCount?: number;
  lastDispatchAt?: string | null;
  loadingStartedAt?: string | null;
  unloadingStartedAt?: string | null;
  lifecycleEventVersion?: number;
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
  status: 'pending' | 'driver_accepted' | 'driver_declined' | 'en_route_pickup' | 'at_pickup' | 'in_transit' | 'arrived_at_drop' | 'completed' | 'partial_delivery' | 'cancelled';
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
