/**
 * =============================================================================
 * TRUCK HOLD SERVICE
 * =============================================================================
 * 
 * Handles the "BookMyShow-style" truck holding system for broadcast orders.
 * 
 * SCALABILITY DESIGN:
 * - Uses atomic operations for concurrent requests
 * - Hold records have TTL (auto-expire)
 * - Designed for Redis/DynamoDB migration (currently in-memory for dev)
 * - Stateless service - can run multiple instances
 * 
 * FLOW:
 * 1. Transporter selects quantity → holdTrucks() → Trucks held for 15 seconds
 * 2. Transporter confirms → confirmHold() → Trucks permanently assigned
 * 3. Timeout or reject → releaseHold() → Trucks available again
 * 
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';
import { socketService } from '../../shared/services/socket.service';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * Status of a truck in the system
 */
export type TruckStatus = 'available' | 'held' | 'assigned' | 'in_transit' | 'completed';

/**
 * Hold record - tracks who is holding which trucks
 */
export interface TruckHold {
  holdId: string;
  orderId: string;
  transporterId: string;
  vehicleType: string;
  vehicleSubtype: string;
  quantity: number;
  truckRequestIds: string[];      // Which specific truck requests are held
  createdAt: Date;
  expiresAt: Date;
  status: 'active' | 'confirmed' | 'expired' | 'released';
}

/**
 * Request to hold trucks
 */
export interface HoldTrucksRequest {
  orderId: string;
  transporterId: string;
  vehicleType: string;
  vehicleSubtype: string;
  quantity: number;
}

/**
 * Response from hold operation
 */
export interface HoldTrucksResponse {
  success: boolean;
  holdId?: string;
  expiresAt?: Date;
  heldQuantity?: number;
  message: string;
  error?: string;
}

/**
 * Truck availability for a vehicle type
 */
export interface TruckAvailability {
  vehicleType: string;
  vehicleSubtype: string;
  totalNeeded: number;
  available: number;
  held: number;
  assigned: number;
  farePerTruck: number;
}

/**
 * Order availability response
 */
export interface OrderAvailability {
  orderId: string;
  customerName: string;
  customerPhone: string;
  pickup: any;
  drop: any;
  distanceKm: number;
  goodsType: string;
  trucks: TruckAvailability[];
  totalValue: number;
  isFullyAssigned: boolean;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Hold configuration - easy to adjust
 */
const CONFIG = {
  HOLD_DURATION_SECONDS: 15,       // How long trucks are held
  CLEANUP_INTERVAL_MS: 5000,       // How often to clean expired holds
  MAX_HOLD_QUANTITY: 50,           // Max trucks one transporter can hold at once
  MIN_HOLD_QUANTITY: 1,            // Minimum trucks to hold
};

// =============================================================================
// IN-MEMORY STORE (Replace with Redis for production)
// =============================================================================

/**
 * In-memory holds store
 * 
 * PRODUCTION: Replace with Redis for:
 * - Persistence across restarts
 * - Distributed locking
 * - Automatic TTL expiry
 * - Horizontal scaling
 */
class HoldStore {
  private holds: Map<string, TruckHold> = new Map();
  private holdsByOrder: Map<string, Set<string>> = new Map();
  private holdsByTransporter: Map<string, Set<string>> = new Map();
  
  /**
   * Add a new hold
   */
  add(hold: TruckHold): void {
    this.holds.set(hold.holdId, hold);
    
    // Index by order
    if (!this.holdsByOrder.has(hold.orderId)) {
      this.holdsByOrder.set(hold.orderId, new Set());
    }
    this.holdsByOrder.get(hold.orderId)!.add(hold.holdId);
    
    // Index by transporter
    if (!this.holdsByTransporter.has(hold.transporterId)) {
      this.holdsByTransporter.set(hold.transporterId, new Set());
    }
    this.holdsByTransporter.get(hold.transporterId)!.add(hold.holdId);
  }
  
  /**
   * Get hold by ID
   */
  get(holdId: string): TruckHold | undefined {
    return this.holds.get(holdId);
  }
  
  /**
   * Update hold status
   */
  updateStatus(holdId: string, status: TruckHold['status']): void {
    const hold = this.holds.get(holdId);
    if (hold) {
      hold.status = status;
    }
  }
  
  /**
   * Remove a hold
   */
  remove(holdId: string): void {
    const hold = this.holds.get(holdId);
    if (!hold) return;
    
    this.holds.delete(holdId);
    this.holdsByOrder.get(hold.orderId)?.delete(holdId);
    this.holdsByTransporter.get(hold.transporterId)?.delete(holdId);
  }
  
  /**
   * Get all active holds for an order
   */
  getActiveHoldsByOrder(orderId: string): TruckHold[] {
    const holdIds = this.holdsByOrder.get(orderId) || new Set();
    const activeHolds: TruckHold[] = [];
    
    for (const holdId of holdIds) {
      const hold = this.holds.get(holdId);
      if (hold && hold.status === 'active' && hold.expiresAt > new Date()) {
        activeHolds.push(hold);
      }
    }
    
    return activeHolds;
  }
  
  /**
   * Get all expired holds (for cleanup)
   */
  getExpiredHolds(): TruckHold[] {
    const now = new Date();
    const expired: TruckHold[] = [];
    
    for (const hold of this.holds.values()) {
      if (hold.status === 'active' && hold.expiresAt <= now) {
        expired.push(hold);
      }
    }
    
    return expired;
  }
  
  /**
   * Get active holds by transporter for a specific order/vehicle type
   */
  getTransporterHold(
    transporterId: string, 
    orderId: string, 
    vehicleType: string, 
    vehicleSubtype: string
  ): TruckHold | undefined {
    const holdIds = this.holdsByTransporter.get(transporterId) || new Set();
    
    for (const holdId of holdIds) {
      const hold = this.holds.get(holdId);
      if (
        hold && 
        hold.status === 'active' &&
        hold.orderId === orderId &&
        hold.vehicleType.toLowerCase() === vehicleType.toLowerCase() &&
        hold.vehicleSubtype.toLowerCase() === vehicleSubtype.toLowerCase() &&
        hold.expiresAt > new Date()
      ) {
        return hold;
      }
    }
    
    return undefined;
  }
}

// Singleton store instance
const holdStore = new HoldStore();

// =============================================================================
// TRUCK HOLD SERVICE
// =============================================================================

class TruckHoldService {
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    this.startCleanupJob();
  }
  
  // ===========================================================================
  // PUBLIC METHODS
  // ===========================================================================
  
  /**
   * HOLD TRUCKS
   * -----------
   * Called when transporter clicks "Accept X trucks"
   * 
   * 1. Validates request
   * 2. Checks availability
   * 3. Marks truck requests as "held"
   * 4. Creates hold record with TTL
   * 5. Broadcasts update to all transporters
   * 
   * @param request - Hold request details
   * @returns HoldTrucksResponse
   */
  async holdTrucks(request: HoldTrucksRequest): Promise<HoldTrucksResponse> {
    const { orderId, transporterId, vehicleType, vehicleSubtype, quantity } = request;
    
    logger.info(`[TruckHold] Hold request: ${quantity}x ${vehicleType} ${vehicleSubtype} for order ${orderId}`);
    
    try {
      // 1. Validate quantity
      if (quantity < CONFIG.MIN_HOLD_QUANTITY || quantity > CONFIG.MAX_HOLD_QUANTITY) {
        return {
          success: false,
          message: `Quantity must be between ${CONFIG.MIN_HOLD_QUANTITY} and ${CONFIG.MAX_HOLD_QUANTITY}`,
          error: 'INVALID_QUANTITY'
        };
      }
      
      // 2. Check if transporter already has a hold for this type
      const existingHold = holdStore.getTransporterHold(transporterId, orderId, vehicleType, vehicleSubtype);
      if (existingHold) {
        return {
          success: false,
          message: 'You already have trucks on hold for this type. Confirm or wait for timeout.',
          error: 'ALREADY_HOLDING'
        };
      }
      
      // 3. Get available truck requests
      const availableTrucks = this.getAvailableTruckRequests(orderId, vehicleType, vehicleSubtype);
      
      if (availableTrucks.length < quantity) {
        return {
          success: false,
          message: `Only ${availableTrucks.length} trucks available. Someone else may have selected them.`,
          error: 'NOT_ENOUGH_AVAILABLE'
        };
      }
      
      // 4. Select the requested quantity of trucks
      const selectedTrucks = availableTrucks.slice(0, quantity);
      const truckRequestIds = selectedTrucks.map(t => t.id);
      
      // 5. Mark them as held in database
      const now = new Date();
      const expiresAt = new Date(now.getTime() + CONFIG.HOLD_DURATION_SECONDS * 1000);
      
      for (const truckId of truckRequestIds) {
        db.updateTruckRequest(truckId, {
          status: 'held',
          heldBy: transporterId,
          heldAt: now.toISOString()
        });
      }
      
      // 6. Create hold record
      const holdId = `HOLD_${uuidv4().substring(0, 8).toUpperCase()}`;
      const hold: TruckHold = {
        holdId,
        orderId,
        transporterId,
        vehicleType,
        vehicleSubtype,
        quantity,
        truckRequestIds,
        createdAt: now,
        expiresAt,
        status: 'active'
      };
      
      holdStore.add(hold);
      
      // 7. Broadcast availability update to all connected clients
      this.broadcastAvailabilityUpdate(orderId);
      
      logger.info(`[TruckHold] ✅ Held ${quantity} trucks. Hold ID: ${holdId}, Expires: ${expiresAt.toISOString()}`);
      
      return {
        success: true,
        holdId,
        expiresAt,
        heldQuantity: quantity,
        message: `${quantity} truck(s) held for ${CONFIG.HOLD_DURATION_SECONDS} seconds. Please confirm.`
      };
      
    } catch (error: any) {
      logger.error(`[TruckHold] Error holding trucks: ${error.message}`, error);
      return {
        success: false,
        message: 'Failed to hold trucks. Please try again.',
        error: 'INTERNAL_ERROR'
      };
    }
  }
  
  /**
   * CONFIRM HOLD
   * ------------
   * Called when transporter confirms their selection within the hold period.
   * 
   * 1. Validates hold exists and is active
   * 2. Marks trucks as "assigned"
   * 3. Marks hold as "confirmed"
   * 4. Broadcasts update
   * 
   * @param holdId - The hold ID to confirm
   * @param transporterId - The transporter confirming
   * @returns Success/failure response
   */
  async confirmHold(holdId: string, transporterId: string): Promise<{ success: boolean; message: string; assignedTrucks?: string[] }> {
    logger.info(`[TruckHold] Confirm request: ${holdId} by ${transporterId}`);
    
    try {
      // 1. Get hold record
      const hold = holdStore.get(holdId);
      
      if (!hold) {
        return { success: false, message: 'Hold not found or expired' };
      }
      
      if (hold.transporterId !== transporterId) {
        return { success: false, message: 'This hold belongs to another transporter' };
      }
      
      if (hold.status !== 'active') {
        return { success: false, message: `Hold is ${hold.status}. Cannot confirm.` };
      }
      
      if (hold.expiresAt <= new Date()) {
        // Release the hold
        await this.releaseHold(holdId, transporterId);
        return { success: false, message: 'Hold expired. Please try again.' };
      }
      
      // 2. Mark trucks as assigned
      for (const truckId of hold.truckRequestIds) {
        db.updateTruckRequest(truckId, {
          status: 'assigned',
          assignedTo: transporterId,
          assignedAt: new Date().toISOString(),
          heldBy: null,
          heldAt: null
        });
      }
      
      // 3. Update order's filled count
      const order = db.getOrderById(hold.orderId);
      if (order) {
        db.updateOrder(hold.orderId, {
          trucksFilled: (order.trucksFilled || 0) + hold.quantity
        });
      }
      
      // 4. Mark hold as confirmed
      holdStore.updateStatus(holdId, 'confirmed');
      
      // 5. Broadcast update
      this.broadcastAvailabilityUpdate(hold.orderId);
      
      logger.info(`[TruckHold] ✅ Confirmed hold ${holdId}. ${hold.quantity} trucks assigned to ${transporterId}`);
      
      return {
        success: true,
        message: `${hold.quantity} truck(s) assigned successfully. Please assign drivers.`,
        assignedTrucks: hold.truckRequestIds
      };
      
    } catch (error: any) {
      logger.error(`[TruckHold] Error confirming hold: ${error.message}`, error);
      return { success: false, message: 'Failed to confirm. Please try again.' };
    }
  }
  
  /**
   * RELEASE HOLD
   * ------------
   * Called when:
   * - Transporter clicks "Reject"
   * - Hold expires (cleanup job)
   * - Transporter closes app
   * 
   * @param holdId - The hold ID to release
   * @param transporterId - The transporter releasing (optional, for validation)
   */
  async releaseHold(holdId: string, transporterId?: string): Promise<{ success: boolean; message: string }> {
    logger.info(`[TruckHold] Release request: ${holdId}`);
    
    try {
      const hold = holdStore.get(holdId);
      
      if (!hold) {
        return { success: false, message: 'Hold not found' };
      }
      
      if (transporterId && hold.transporterId !== transporterId) {
        return { success: false, message: 'This hold belongs to another transporter' };
      }
      
      if (hold.status !== 'active') {
        return { success: true, message: 'Hold already released' };
      }
      
      // 1. Mark trucks as available again
      for (const truckId of hold.truckRequestIds) {
        db.updateTruckRequest(truckId, {
          status: 'available',
          heldBy: null,
          heldAt: null
        });
      }
      
      // 2. Mark hold as released
      holdStore.updateStatus(holdId, 'released');
      holdStore.remove(holdId);
      
      // 3. Broadcast update
      this.broadcastAvailabilityUpdate(hold.orderId);
      
      logger.info(`[TruckHold] ✅ Released hold ${holdId}. ${hold.quantity} trucks available again.`);
      
      return { success: true, message: 'Hold released. Trucks are available again.' };
      
    } catch (error: any) {
      logger.error(`[TruckHold] Error releasing hold: ${error.message}`, error);
      return { success: false, message: 'Failed to release hold' };
    }
  }
  
  /**
   * GET ORDER AVAILABILITY
   * ----------------------
   * Returns current availability of all truck types for an order.
   * Used by app to show real-time counts.
   * 
   * @param orderId - The order ID
   * @returns OrderAvailability with truck counts
   */
  async getOrderAvailability(orderId: string): Promise<OrderAvailability | null> {
    try {
      const order = db.getOrderById(orderId);
      if (!order) {
        logger.warn(`[TruckHold] Order not found: ${orderId}`);
        return null;
      }
      
      const truckRequests = db.getTruckRequestsByOrder ? db.getTruckRequestsByOrder(orderId) : [];
      
      // Group by vehicle type
      const truckGroups = new Map<string, {
        requests: any[];
        farePerTruck: number;
      }>();
      
      for (const tr of truckRequests) {
        const key = `${tr.vehicleType}_${tr.vehicleSubtype || ''}`;
        if (!truckGroups.has(key)) {
          truckGroups.set(key, {
            requests: [],
            farePerTruck: tr.pricePerTruck
          });
        }
        truckGroups.get(key)!.requests.push(tr);
      }
      
      // Calculate availability for each type
      const trucks: TruckAvailability[] = [];
      let totalValue = 0;
      
      for (const [key, group] of truckGroups) {
        const [vehicleType, vehicleSubtype] = key.split('_');
        
        const available = group.requests.filter(r => r.status === 'available').length;
        const held = group.requests.filter(r => r.status === 'held').length;
        const assigned = group.requests.filter(r => r.status === 'assigned' || r.status === 'completed').length;
        
        trucks.push({
          vehicleType,
          vehicleSubtype: vehicleSubtype || '',
          totalNeeded: group.requests.length,
          available,
          held,
          assigned,
          farePerTruck: group.farePerTruck
        });
        
        totalValue += group.requests.length * group.farePerTruck;
      }
      
      const isFullyAssigned = trucks.every(t => t.available === 0 && t.held === 0);
      
      return {
        orderId,
        customerName: order.customerName || 'Customer',
        customerPhone: order.customerPhone || '',
        pickup: order.pickup,
        drop: order.drop,
        distanceKm: order.distanceKm || 0,
        goodsType: order.goodsType || 'General',
        trucks,
        totalValue,
        isFullyAssigned
      };
      
    } catch (error: any) {
      logger.error(`[TruckHold] Error getting availability: ${error.message}`, error);
      return null;
    }
  }
  
  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================
  
  /**
   * Get available (not held, not assigned) truck requests for a vehicle type
   */
  private getAvailableTruckRequests(orderId: string, vehicleType: string, vehicleSubtype: string): any[] {
    const allRequests = db.getTruckRequestsByOrder ? db.getTruckRequestsByOrder(orderId) : [];
    
    return allRequests.filter(tr => 
      tr.vehicleType.toLowerCase() === vehicleType.toLowerCase() &&
      (tr.vehicleSubtype || '').toLowerCase() === vehicleSubtype.toLowerCase() &&
      tr.status === 'available'
    );
  }
  
  /**
   * Broadcast availability update via WebSocket
   */
  private broadcastAvailabilityUpdate(orderId: string): void {
    this.getOrderAvailability(orderId).then(availability => {
      if (availability) {
        socketService.broadcastToAll('trucks_availability_updated', {
          orderId,
          trucks: availability.trucks,
          isFullyAssigned: availability.isFullyAssigned,
          timestamp: new Date().toISOString()
        });
        
        logger.debug(`[TruckHold] Broadcasted availability update for order ${orderId}`);
      }
    });
  }
  
  /**
   * Cleanup job - releases expired holds
   */
  private startCleanupJob(): void {
    this.cleanupInterval = setInterval(() => {
      const expiredHolds = holdStore.getExpiredHolds();
      
      for (const hold of expiredHolds) {
        logger.info(`[TruckHold] Auto-releasing expired hold: ${hold.holdId}`);
        this.releaseHold(hold.holdId);
      }
      
      if (expiredHolds.length > 0) {
        logger.info(`[TruckHold] Cleanup: Released ${expiredHolds.length} expired holds`);
      }
    }, CONFIG.CLEANUP_INTERVAL_MS);
    
    logger.info(`[TruckHold] Cleanup job started (every ${CONFIG.CLEANUP_INTERVAL_MS / 1000}s)`);
  }
  
  /**
   * Stop cleanup job (for graceful shutdown)
   */
  stopCleanupJob(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info('[TruckHold] Cleanup job stopped');
    }
  }
}

// =============================================================================
// EXPORT SINGLETON
// =============================================================================

export const truckHoldService = new TruckHoldService();
