/**
 * =============================================================================
 * VEHICLE CATALOG - TONNAGE & CAPACITY DATA
 * =============================================================================
 * 
 * Comprehensive vehicle catalog with tonnage-based pricing data.
 * Used for:
 * - Tonnage-based pricing calculations
 * - Vehicle suggestions based on cargo weight
 * - Capacity validation
 * 
 * =============================================================================
 */

/**
 * Vehicle subtype configuration with tonnage data
 */
export interface VehicleSubtypeConfig {
  name: string;
  minTonnage: number;      // Minimum tonnage capacity
  maxTonnage: number;      // Maximum tonnage capacity
  capacityKg: number;      // Capacity in kilograms
  lengthFeet?: number;     // Length in feet (for length-based vehicles)
  baseRateMultiplier: number;  // Multiplier for base rate
}

/**
 * Vehicle type configuration
 */
export interface VehicleTypeConfig {
  id: string;
  displayName: string;
  category: 'tonnage' | 'length' | 'volume';  // Pricing category
  baseRate: number;        // Base rate in INR
  perKmRate: number;       // Rate per kilometer
  perTonPerKmRate: number; // Rate per ton per km (for tonnage-based)
  minCharge: number;       // Minimum charge
  subtypes: Record<string, VehicleSubtypeConfig>;
}

/**
 * Complete Vehicle Catalog
 * Pricing is based on actual industry rates for India logistics
 */
export const VEHICLE_CATALOG: Record<string, VehicleTypeConfig> = {
  
  // =========================================================================
  // MINI / PICKUP - Small cargo, local deliveries
  // =========================================================================
  mini: {
    id: 'mini',
    displayName: 'Mini/Pickup',
    category: 'tonnage',
    baseRate: 500,
    perKmRate: 12,
    perTonPerKmRate: 8,
    minCharge: 800,
    subtypes: {
      'Pickup Truck - Dost': {
        name: 'Pickup Truck - Dost',
        minTonnage: 0.5,
        maxTonnage: 1.5,
        capacityKg: 1500,
        baseRateMultiplier: 1.0
      },
      'Mini Truck - Tata Ace': {
        name: 'Mini Truck - Tata Ace',
        minTonnage: 0.5,
        maxTonnage: 1.0,
        capacityKg: 1000,
        baseRateMultiplier: 0.9
      }
    }
  },

  // =========================================================================
  // LCV - Light Commercial Vehicles
  // =========================================================================
  lcv: {
    id: 'lcv',
    displayName: 'LCV',
    category: 'length',
    baseRate: 800,
    perKmRate: 15,
    perTonPerKmRate: 6,
    minCharge: 1200,
    subtypes: {
      'LCV Open - 14 Feet': {
        name: 'LCV Open - 14 Feet',
        minTonnage: 2,
        maxTonnage: 4,
        capacityKg: 4000,
        lengthFeet: 14,
        baseRateMultiplier: 1.0
      },
      'LCV Open - 17 Feet': {
        name: 'LCV Open - 17 Feet',
        minTonnage: 3,
        maxTonnage: 5,
        capacityKg: 5000,
        lengthFeet: 17,
        baseRateMultiplier: 1.15
      },
      'LCV Open - 19 Feet': {
        name: 'LCV Open - 19 Feet',
        minTonnage: 4,
        maxTonnage: 6,
        capacityKg: 6000,
        lengthFeet: 19,
        baseRateMultiplier: 1.25
      },
      'LCV Container - 14 Feet': {
        name: 'LCV Container - 14 Feet',
        minTonnage: 2,
        maxTonnage: 4,
        capacityKg: 4000,
        lengthFeet: 14,
        baseRateMultiplier: 1.1
      },
      'LCV Container - 17 Feet': {
        name: 'LCV Container - 17 Feet',
        minTonnage: 3,
        maxTonnage: 5,
        capacityKg: 5000,
        lengthFeet: 17,
        baseRateMultiplier: 1.25
      },
      'LCV Container - 19 Feet': {
        name: 'LCV Container - 19 Feet',
        minTonnage: 4,
        maxTonnage: 6,
        capacityKg: 6000,
        lengthFeet: 19,
        baseRateMultiplier: 1.35
      },
      'LCV Container - 32 Feet SXL': {
        name: 'LCV Container - 32 Feet SXL',
        minTonnage: 7,
        maxTonnage: 9,
        capacityKg: 9000,
        lengthFeet: 32,
        baseRateMultiplier: 1.6
      }
    }
  },

  // =========================================================================
  // OPEN TRUCKS - General cargo
  // =========================================================================
  open: {
    id: 'open',
    displayName: 'Open',
    category: 'length',
    baseRate: 1500,
    perKmRate: 25,
    perTonPerKmRate: 4,
    minCharge: 2000,
    subtypes: {
      '17 Feet': {
        name: '17 Feet',
        minTonnage: 5,
        maxTonnage: 7,
        capacityKg: 7000,
        lengthFeet: 17,
        baseRateMultiplier: 1.0
      },
      '19 Feet': {
        name: '19 Feet',
        minTonnage: 6,
        maxTonnage: 9,
        capacityKg: 9000,
        lengthFeet: 19,
        baseRateMultiplier: 1.1
      },
      '20 Feet': {
        name: '20 Feet',
        minTonnage: 7,
        maxTonnage: 10,
        capacityKg: 10000,
        lengthFeet: 20,
        baseRateMultiplier: 1.15
      },
      '22 Feet': {
        name: '22 Feet',
        minTonnage: 9,
        maxTonnage: 12,
        capacityKg: 12000,
        lengthFeet: 22,
        baseRateMultiplier: 1.25
      },
      '24 Feet': {
        name: '24 Feet',
        minTonnage: 10,
        maxTonnage: 15,
        capacityKg: 15000,
        lengthFeet: 24,
        baseRateMultiplier: 1.35
      },
      '10 Wheeler': {
        name: '10 Wheeler',
        minTonnage: 15,
        maxTonnage: 21,
        capacityKg: 21000,
        baseRateMultiplier: 1.6
      },
      '12 Wheeler': {
        name: '12 Wheeler',
        minTonnage: 21,
        maxTonnage: 25,
        capacityKg: 25000,
        baseRateMultiplier: 1.8
      },
      '14 Wheeler': {
        name: '14 Wheeler',
        minTonnage: 25,
        maxTonnage: 30,
        capacityKg: 30000,
        baseRateMultiplier: 2.0
      },
      '16 Wheeler': {
        name: '16 Wheeler',
        minTonnage: 30,
        maxTonnage: 35,
        capacityKg: 35000,
        baseRateMultiplier: 2.2
      },
      '18 Wheeler': {
        name: '18 Wheeler',
        minTonnage: 35,
        maxTonnage: 40,
        capacityKg: 40000,
        baseRateMultiplier: 2.4
      }
    }
  },

  // =========================================================================
  // CONTAINER TRUCKS
  // =========================================================================
  container: {
    id: 'container',
    displayName: 'Container',
    category: 'length',
    baseRate: 2000,
    perKmRate: 30,
    perTonPerKmRate: 4.5,
    minCharge: 2500,
    subtypes: {
      '19 Feet': {
        name: '19 Feet',
        minTonnage: 6,
        maxTonnage: 9,
        capacityKg: 9000,
        lengthFeet: 19,
        baseRateMultiplier: 1.0
      },
      '20 Feet': {
        name: '20 Feet',
        minTonnage: 7,
        maxTonnage: 10,
        capacityKg: 10000,
        lengthFeet: 20,
        baseRateMultiplier: 1.05
      },
      '22 Feet': {
        name: '22 Feet',
        minTonnage: 9,
        maxTonnage: 14,
        capacityKg: 14000,
        lengthFeet: 22,
        baseRateMultiplier: 1.2
      },
      '24 Feet': {
        name: '24 Feet',
        minTonnage: 10,
        maxTonnage: 16,
        capacityKg: 16000,
        lengthFeet: 24,
        baseRateMultiplier: 1.35
      },
      '32 Feet Single Axle': {
        name: '32 Feet Single Axle',
        minTonnage: 14,
        maxTonnage: 18,
        capacityKg: 18000,
        lengthFeet: 32,
        baseRateMultiplier: 1.5
      },
      '32 Feet Multi Axle': {
        name: '32 Feet Multi Axle',
        minTonnage: 18,
        maxTonnage: 24,
        capacityKg: 24000,
        lengthFeet: 32,
        baseRateMultiplier: 1.7
      },
      '32 Feet Triple Axle': {
        name: '32 Feet Triple Axle',
        minTonnage: 24,
        maxTonnage: 28,
        capacityKg: 28000,
        lengthFeet: 32,
        baseRateMultiplier: 1.9
      }
    }
  },

  // =========================================================================
  // TRAILER - Heavy loads
  // =========================================================================
  trailer: {
    id: 'trailer',
    displayName: 'Trailer',
    category: 'tonnage',
    baseRate: 3000,
    perKmRate: 40,
    perTonPerKmRate: 3.5,
    minCharge: 4000,
    subtypes: {
      '8-11 Ton': {
        name: '8-11 Ton',
        minTonnage: 8,
        maxTonnage: 11,
        capacityKg: 11000,
        baseRateMultiplier: 1.0
      },
      '12-15 Ton': {
        name: '12-15 Ton',
        minTonnage: 12,
        maxTonnage: 15,
        capacityKg: 15000,
        baseRateMultiplier: 1.15
      },
      '16-19 Ton': {
        name: '16-19 Ton',
        minTonnage: 16,
        maxTonnage: 19,
        capacityKg: 19000,
        baseRateMultiplier: 1.3
      },
      '20-22 Ton': {
        name: '20-22 Ton',
        minTonnage: 20,
        maxTonnage: 22,
        capacityKg: 22000,
        baseRateMultiplier: 1.45
      },
      '23-25 Ton': {
        name: '23-25 Ton',
        minTonnage: 23,
        maxTonnage: 25,
        capacityKg: 25000,
        baseRateMultiplier: 1.55
      },
      '26-28 Ton': {
        name: '26-28 Ton',
        minTonnage: 26,
        maxTonnage: 28,
        capacityKg: 28000,
        baseRateMultiplier: 1.7
      },
      '29-31 Ton': {
        name: '29-31 Ton',
        minTonnage: 29,
        maxTonnage: 31,
        capacityKg: 31000,
        baseRateMultiplier: 1.85
      },
      '32-35 Ton': {
        name: '32-35 Ton',
        minTonnage: 32,
        maxTonnage: 35,
        capacityKg: 35000,
        baseRateMultiplier: 2.0
      },
      '36-41 Ton': {
        name: '36-41 Ton',
        minTonnage: 36,
        maxTonnage: 41,
        capacityKg: 41000,
        baseRateMultiplier: 2.2
      },
      '42+ Ton': {
        name: '42+ Ton',
        minTonnage: 42,
        maxTonnage: 50,
        capacityKg: 50000,
        baseRateMultiplier: 2.5
      }
    }
  },

  // =========================================================================
  // TIPPER - Construction materials
  // =========================================================================
  tipper: {
    id: 'tipper',
    displayName: 'Tipper',
    category: 'tonnage',
    baseRate: 2500,
    perKmRate: 35,
    perTonPerKmRate: 3.8,
    minCharge: 3000,
    subtypes: {
      '9-11 Ton': {
        name: '9-11 Ton',
        minTonnage: 9,
        maxTonnage: 11,
        capacityKg: 11000,
        baseRateMultiplier: 1.0
      },
      '15-17 Ton': {
        name: '15-17 Ton',
        minTonnage: 15,
        maxTonnage: 17,
        capacityKg: 17000,
        baseRateMultiplier: 1.25
      },
      '18-19 Ton': {
        name: '18-19 Ton',
        minTonnage: 18,
        maxTonnage: 19,
        capacityKg: 19000,
        baseRateMultiplier: 1.35
      },
      '20-24 Ton': {
        name: '20-24 Ton',
        minTonnage: 20,
        maxTonnage: 24,
        capacityKg: 24000,
        baseRateMultiplier: 1.5
      },
      '25 Ton': {
        name: '25 Ton',
        minTonnage: 25,
        maxTonnage: 25,
        capacityKg: 25000,
        baseRateMultiplier: 1.6
      },
      '26-28 Ton': {
        name: '26-28 Ton',
        minTonnage: 26,
        maxTonnage: 28,
        capacityKg: 28000,
        baseRateMultiplier: 1.75
      },
      '29 Ton': {
        name: '29 Ton',
        minTonnage: 29,
        maxTonnage: 29,
        capacityKg: 29000,
        baseRateMultiplier: 1.85
      },
      '30 Ton': {
        name: '30 Ton',
        minTonnage: 30,
        maxTonnage: 30,
        capacityKg: 30000,
        baseRateMultiplier: 1.95
      }
    }
  },

  // =========================================================================
  // TANKER - Liquid cargo
  // =========================================================================
  tanker: {
    id: 'tanker',
    displayName: 'Tanker',
    category: 'tonnage',
    baseRate: 3500,
    perKmRate: 45,
    perTonPerKmRate: 4.0,
    minCharge: 4500,
    subtypes: {
      '8-11 Ton': {
        name: '8-11 Ton',
        minTonnage: 8,
        maxTonnage: 11,
        capacityKg: 11000,
        baseRateMultiplier: 1.0
      },
      '12-15 Ton': {
        name: '12-15 Ton',
        minTonnage: 12,
        maxTonnage: 15,
        capacityKg: 15000,
        baseRateMultiplier: 1.2
      },
      '16-20 Ton': {
        name: '16-20 Ton',
        minTonnage: 16,
        maxTonnage: 20,
        capacityKg: 20000,
        baseRateMultiplier: 1.4
      },
      '21-25 Ton': {
        name: '21-25 Ton',
        minTonnage: 21,
        maxTonnage: 25,
        capacityKg: 25000,
        baseRateMultiplier: 1.6
      },
      '26-29 Ton': {
        name: '26-29 Ton',
        minTonnage: 26,
        maxTonnage: 29,
        capacityKg: 29000,
        baseRateMultiplier: 1.8
      },
      '30-31 Ton': {
        name: '30-31 Ton',
        minTonnage: 30,
        maxTonnage: 31,
        capacityKg: 31000,
        baseRateMultiplier: 1.95
      },
      '32-35 Ton': {
        name: '32-35 Ton',
        minTonnage: 32,
        maxTonnage: 35,
        capacityKg: 35000,
        baseRateMultiplier: 2.1
      },
      '36 Ton': {
        name: '36 Ton',
        minTonnage: 36,
        maxTonnage: 36,
        capacityKg: 36000,
        baseRateMultiplier: 2.25
      }
    }
  },

  // =========================================================================
  // DUMPER - Mining & construction
  // =========================================================================
  dumper: {
    id: 'dumper',
    displayName: 'Dumper',
    category: 'tonnage',
    baseRate: 4000,
    perKmRate: 50,
    perTonPerKmRate: 4.2,
    minCharge: 5000,
    subtypes: {
      '9-11 Ton': {
        name: '9-11 Ton',
        minTonnage: 9,
        maxTonnage: 11,
        capacityKg: 11000,
        baseRateMultiplier: 1.0
      },
      '12-15 Ton': {
        name: '12-15 Ton',
        minTonnage: 12,
        maxTonnage: 15,
        capacityKg: 15000,
        baseRateMultiplier: 1.2
      },
      '16-19 Ton': {
        name: '16-19 Ton',
        minTonnage: 16,
        maxTonnage: 19,
        capacityKg: 19000,
        baseRateMultiplier: 1.4
      },
      '20-22 Ton': {
        name: '20-22 Ton',
        minTonnage: 20,
        maxTonnage: 22,
        capacityKg: 22000,
        baseRateMultiplier: 1.55
      },
      '23-25 Ton': {
        name: '23-25 Ton',
        minTonnage: 23,
        maxTonnage: 25,
        capacityKg: 25000,
        baseRateMultiplier: 1.7
      },
      '26-28 Ton': {
        name: '26-28 Ton',
        minTonnage: 26,
        maxTonnage: 28,
        capacityKg: 28000,
        baseRateMultiplier: 1.85
      },
      '29-30 Ton': {
        name: '29-30 Ton',
        minTonnage: 29,
        maxTonnage: 30,
        capacityKg: 30000,
        baseRateMultiplier: 2.0
      },
      '31+ Ton': {
        name: '31+ Ton',
        minTonnage: 31,
        maxTonnage: 40,
        capacityKg: 40000,
        baseRateMultiplier: 2.2
      }
    }
  },

  // =========================================================================
  // BULKER - Bulk materials (cement, grains, etc.)
  // =========================================================================
  bulker: {
    id: 'bulker',
    displayName: 'Bulker',
    category: 'tonnage',
    baseRate: 4500,
    perKmRate: 55,
    perTonPerKmRate: 4.5,
    minCharge: 5500,
    subtypes: {
      '20-22 Ton': {
        name: '20-22 Ton',
        minTonnage: 20,
        maxTonnage: 22,
        capacityKg: 22000,
        baseRateMultiplier: 1.0
      },
      '23-25 Ton': {
        name: '23-25 Ton',
        minTonnage: 23,
        maxTonnage: 25,
        capacityKg: 25000,
        baseRateMultiplier: 1.15
      },
      '26-28 Ton': {
        name: '26-28 Ton',
        minTonnage: 26,
        maxTonnage: 28,
        capacityKg: 28000,
        baseRateMultiplier: 1.3
      },
      '29-31 Ton': {
        name: '29-31 Ton',
        minTonnage: 29,
        maxTonnage: 31,
        capacityKg: 31000,
        baseRateMultiplier: 1.45
      },
      '32+ Ton': {
        name: '32+ Ton',
        minTonnage: 32,
        maxTonnage: 40,
        capacityKg: 40000,
        baseRateMultiplier: 1.6
      }
    }
  }
};

/**
 * Distance slab configuration for pricing
 * Short haul costs more per km, long haul gets discount
 */
export const DISTANCE_SLABS = [
  { maxKm: 50, multiplier: 1.3, label: 'Local' },
  { maxKm: 100, multiplier: 1.2, label: 'Short Haul' },
  { maxKm: 300, multiplier: 1.0, label: 'Medium Haul' },
  { maxKm: 500, multiplier: 0.95, label: 'Long Haul' },
  { maxKm: Infinity, multiplier: 0.9, label: 'Very Long Haul' }
];

/**
 * Get distance slab multiplier
 */
export function getDistanceSlabMultiplier(distanceKm: number): { multiplier: number; label: string } {
  for (const slab of DISTANCE_SLABS) {
    if (distanceKm <= slab.maxKm) {
      return { multiplier: slab.multiplier, label: slab.label };
    }
  }
  return { multiplier: 0.9, label: 'Very Long Haul' };
}

/**
 * Get vehicle config by type
 */
export function getVehicleConfig(vehicleType: string): VehicleTypeConfig | null {
  return VEHICLE_CATALOG[vehicleType.toLowerCase()] || null;
}

/**
 * Get subtype config
 */
export function getSubtypeConfig(vehicleType: string, subtype: string): VehicleSubtypeConfig | null {
  const vehicleConfig = getVehicleConfig(vehicleType);
  if (!vehicleConfig) return null;
  
  // Try exact match first
  if (vehicleConfig.subtypes[subtype]) {
    return vehicleConfig.subtypes[subtype];
  }
  
  // Try case-insensitive match
  const subtypeLower = subtype.toLowerCase();
  for (const [key, config] of Object.entries(vehicleConfig.subtypes)) {
    if (key.toLowerCase() === subtypeLower) {
      return config;
    }
  }
  
  return null;
}

/**
 * Find suitable vehicles for a given cargo weight
 * Returns vehicles that can carry the weight, sorted by price
 */
export function findSuitableVehicles(
  cargoWeightKg: number,
  preferredType?: string
): Array<{
  vehicleType: string;
  subtype: string;
  capacityKg: number;
  baseRateMultiplier: number;
  isExactFit: boolean;
  isOversized: boolean;
}> {
  const results: Array<{
    vehicleType: string;
    subtype: string;
    capacityKg: number;
    baseRateMultiplier: number;
    isExactFit: boolean;
    isOversized: boolean;
  }> = [];

  // Search through all vehicle types
  const typesToSearch = preferredType 
    ? [preferredType.toLowerCase()] 
    : Object.keys(VEHICLE_CATALOG);

  for (const vehicleType of typesToSearch) {
    const config = VEHICLE_CATALOG[vehicleType];
    if (!config) continue;

    for (const [subtypeName, subtype] of Object.entries(config.subtypes)) {
      if (subtype.capacityKg >= cargoWeightKg) {
        const utilizationRatio = cargoWeightKg / subtype.capacityKg;
        
        results.push({
          vehicleType,
          subtype: subtypeName,
          capacityKg: subtype.capacityKg,
          baseRateMultiplier: subtype.baseRateMultiplier,
          isExactFit: utilizationRatio >= 0.7 && utilizationRatio <= 1.0,
          isOversized: utilizationRatio < 0.5
        });
      }
    }
  }

  // Sort by capacity (smallest suitable first)
  results.sort((a, b) => a.capacityKg - b.capacityKg);

  return results;
}

/**
 * Get all vehicle types for catalog display
 */
export function getAllVehicleTypes(): Array<{
  id: string;
  displayName: string;
  minCapacity: number;
  maxCapacity: number;
  startingRate: number;
}> {
  return Object.values(VEHICLE_CATALOG).map(config => {
    const capacities = Object.values(config.subtypes).map(s => s.capacityKg);
    return {
      id: config.id,
      displayName: config.displayName,
      minCapacity: Math.min(...capacities),
      maxCapacity: Math.max(...capacities),
      startingRate: config.baseRate
    };
  });
}
