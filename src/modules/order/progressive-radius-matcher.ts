import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';

export interface RadiusStep {
  radiusKm: number;
  windowMs: number;
}

export interface ProgressiveMatchState {
  orderId: string;
  vehicleType: string;
  vehicleSubtype: string;
  stepIndex: number;
}

export interface CandidateTransporter {
  transporterId: string;
  distanceKm: number;
  latitude: number;
  longitude: number;
}

export const PROGRESSIVE_RADIUS_STEPS: RadiusStep[] = [
  { radiusKm: 10, windowMs: 20_000 },
  { radiusKm: 25, windowMs: 20_000 },
  { radiusKm: 30, windowMs: 20_000 }
];

function toRadians(value: number): number {
  return value * (Math.PI / 180);
}

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

class ProgressiveRadiusMatcher {
  getStep(stepIndex: number): RadiusStep | undefined {
    if (stepIndex < 0 || stepIndex >= PROGRESSIVE_RADIUS_STEPS.length) return undefined;
    return PROGRESSIVE_RADIUS_STEPS[stepIndex];
  }

  async findCandidates(params: {
    pickupLat: number;
    pickupLng: number;
    vehicleType: string;
    vehicleSubtype: string;
    stepIndex: number;
    alreadyNotified: Set<string>;
    limit?: number;
  }): Promise<CandidateTransporter[]> {
    const {
      pickupLat,
      pickupLng,
      vehicleType,
      vehicleSubtype,
      stepIndex,
      alreadyNotified,
      limit = 250
    } = params;
    const step = this.getStep(stepIndex);
    if (!step) return [];

    const vehicleKey = generateVehicleKey(vehicleType, vehicleSubtype);
    const nearby = await availabilityService.getAvailableTransportersWithDetails(
      vehicleKey,
      pickupLat,
      pickupLng,
      Math.max(limit * 2, 100),
      step.radiusKm
    );

    return nearby
      .map((driver) => {
        const strictDistanceKm = haversineDistanceKm(
          pickupLat,
          pickupLng,
          driver.latitude,
          driver.longitude
        );
        return {
          transporterId: driver.transporterId,
          distanceKm: strictDistanceKm,
          latitude: driver.latitude,
          longitude: driver.longitude
        };
      })
      .filter((candidate) => {
        return candidate.distanceKm <= step.radiusKm &&
          !alreadyNotified.has(candidate.transporterId);
      })
      .sort((left, right) => left.distanceKm - right.distanceKm)
      .slice(0, limit);
  }
}

export const progressiveRadiusMatcher = new ProgressiveRadiusMatcher();
