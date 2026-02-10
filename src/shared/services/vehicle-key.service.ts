/**
 * =============================================================================
 * VEHICLE KEY SERVICE
 * =============================================================================
 * 
 * Handles vehicle type normalization at ONBOARDING time (not booking time).
 * This is a critical optimization for scalability.
 * 
 * WHY NORMALIZE AT ONBOARDING:
 * - Booking-time normalization = SLOW (runs on every booking request)
 * - Onboarding-time normalization = FAST (runs once when vehicle is registered)
 * 
 * NORMALIZED KEY FORMAT:
 * - Input: "Open", "17 Feet" or "open", "17_feet" or "OPEN", "17-feet"
 * - Output: "open_17ft" (lowercase, underscores, abbreviated)
 * 
 * USAGE:
 * - At vehicle registration: store vehicleKey = generateVehicleKey(type, subtype)
 * - At booking: lookup by vehicleKey directly (no normalization needed)
 * 
 * @author Weelo Team
 * @version 1.0.0
 */

import { logger } from './logger.service';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Standard abbreviations for common terms
 * Keeps keys short and consistent
 */
const ABBREVIATIONS: Record<string, string> = {
  'feet': 'ft',
  'foot': 'ft',
  'ton': 't',
  'tonnes': 't',
  'tonne': 't',
  'wheeler': 'w',
  'wheel': 'w',
  'axle': 'ax',
  'single': 's',
  'multi': 'm',
  'double': 'd',
  'triple': 'tr',
  'open': 'open',
  'container': 'cont',
  'trailer': 'trail',
  'tipper': 'tip',
  'tanker': 'tank',
  'dumper': 'dump',
  'bulker': 'bulk',
  'flatbed': 'flat',
  'refrigerated': 'ref',
  'lcv': 'lcv',
  'mini': 'mini',
  'pickup': 'pick',
};

/**
 * Vehicle type display names (for reverse lookup)
 */
const VEHICLE_TYPE_DISPLAY: Record<string, string> = {
  'open': 'Open',
  'cont': 'Container',
  'trail': 'Trailer',
  'tip': 'Tipper',
  'tank': 'Tanker',
  'dump': 'Dumper',
  'bulk': 'Bulker',
  'flat': 'Flatbed',
  'ref': 'Refrigerated',
  'lcv': 'LCV',
  'mini': 'Mini',
  'pick': 'Pickup',
};

// =============================================================================
// SERVICE CLASS
// =============================================================================

class VehicleKeyService {
  
  /**
   * Generate a normalized vehicle key from type and subtype
   * 
   * @example
   * generateVehicleKey("Open", "17 Feet") => "open_17ft"
   * generateVehicleKey("Container", "20 Feet") => "cont_20ft"
   * generateVehicleKey("Trailer", "20-24 Ton") => "trail_20_24t"
   * generateVehicleKey("LCV", "Open 14 Feet") => "lcv_open_14ft"
   * 
   * @param vehicleType - The vehicle type (e.g., "Open", "Container")
   * @param vehicleSubtype - The vehicle subtype (e.g., "17 Feet", "20-24 Ton")
   * @returns Normalized key (e.g., "open_17ft")
   */
  generateVehicleKey(vehicleType: string, vehicleSubtype: string): string {
    const normalizedType = this.normalizeString(vehicleType);
    const normalizedSubtype = this.normalizeString(vehicleSubtype);
    
    // Combine with underscore separator
    const key = `${normalizedType}_${normalizedSubtype}`;
    
    logger.debug(`[VehicleKey] Generated: "${vehicleType}/${vehicleSubtype}" => "${key}"`);
    
    return key;
  }
  
  /**
   * Normalize a string for use in vehicle keys
   * 
   * Process:
   * 1. Lowercase
   * 2. Replace common terms with abbreviations
   * 3. Remove special characters except numbers
   * 4. Replace spaces/hyphens with underscores
   * 5. Clean up multiple underscores
   * 
   * @param str - Input string to normalize
   * @returns Normalized string
   */
  normalizeString(str: string): string {
    if (!str) return '';
    
    let normalized = str.toLowerCase().trim();
    
    // Apply abbreviations (order matters - longer words first)
    const sortedAbbrevs = Object.entries(ABBREVIATIONS)
      .sort((a, b) => b[0].length - a[0].length);
    
    for (const [word, abbrev] of sortedAbbrevs) {
      // Use word boundary matching to avoid partial replacements
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      normalized = normalized.replace(regex, abbrev);
    }
    
    // Replace separators with underscore
    normalized = normalized.replace(/[\s\-\.\/]+/g, '_');
    
    // Remove any remaining special characters (keep alphanumeric and underscore)
    normalized = normalized.replace(/[^a-z0-9_]/g, '');
    
    // Clean up multiple underscores
    normalized = normalized.replace(/_+/g, '_');
    
    // Remove leading/trailing underscores
    normalized = normalized.replace(/^_|_$/g, '');
    
    return normalized;
  }
  
  /**
   * Check if two vehicle keys match
   * Use this for comparing user input with stored keys
   * 
   * @param key1 - First key (can be normalized or raw)
   * @param key2 - Second key (can be normalized or raw)
   * @returns true if keys match after normalization
   */
  keysMatch(key1: string, key2: string): boolean {
    const norm1 = this.normalizeString(key1);
    const norm2 = this.normalizeString(key2);
    return norm1 === norm2;
  }
  
  /**
   * Parse a vehicle key back into type and subtype
   * Note: This is approximate - some information may be lost in normalization
   * 
   * @param vehicleKey - Normalized vehicle key
   * @returns { type, subtype } or null if cannot parse
   */
  parseVehicleKey(vehicleKey: string): { type: string; subtype: string } | null {
    if (!vehicleKey) return null;
    
    const parts = vehicleKey.split('_');
    if (parts.length < 2) return null;
    
    const typeKey = parts[0];
    const subtypeKey = parts.slice(1).join('_');
    
    const type = VEHICLE_TYPE_DISPLAY[typeKey] || typeKey;
    const subtype = this.expandSubtype(subtypeKey);
    
    return { type, subtype };
  }
  
  /**
   * Expand a normalized subtype back to display format
   * @param subtypeKey - Normalized subtype
   * @returns Display-friendly subtype
   */
  private expandSubtype(subtypeKey: string): string {
    let expanded = subtypeKey;
    
    // Expand abbreviations
    expanded = expanded.replace(/ft/g, ' Feet');
    expanded = expanded.replace(/(\d+)t/g, '$1 Ton');
    expanded = expanded.replace(/(\d+)w/g, '$1 Wheeler');
    expanded = expanded.replace(/ax/g, ' Axle');
    expanded = expanded.replace(/_/g, ' ');
    
    // Title case
    expanded = expanded.replace(/\b\w/g, c => c.toUpperCase());
    
    return expanded.trim();
  }
  
  /**
   * Get all known vehicle type keys for validation
   */
  getKnownVehicleTypes(): string[] {
    return Object.keys(VEHICLE_TYPE_DISPLAY);
  }
  
  /**
   * Validate if a vehicle key looks correct
   * @param key - Key to validate
   * @returns true if key format is valid
   */
  isValidKey(key: string): boolean {
    if (!key) return false;
    
    // Must have at least type_subtype format
    if (!key.includes('_')) return false;
    
    // Must be lowercase alphanumeric with underscores
    if (!/^[a-z0-9_]+$/.test(key)) return false;
    
    return true;
  }
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const vehicleKeyService = new VehicleKeyService();

// Also export individual functions for convenience
export const generateVehicleKey = (type: string, subtype: string) => 
  vehicleKeyService.generateVehicleKey(type, subtype);

export const normalizeVehicleString = (str: string) => 
  vehicleKeyService.normalizeString(str);

export const vehicleKeysMatch = (key1: string, key2: string) => 
  vehicleKeyService.keysMatch(key1, key2);
