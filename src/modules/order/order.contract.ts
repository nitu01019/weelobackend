import type {
  CreateOrderRequest,
  CreateOrderResponse,
  RoutePointInput,
  VehicleRequirement
} from './order.service';
import { AppError } from '../../shared/types/error.types';

interface NormalizedLocationInput {
  latitude: number;
  longitude: number;
  address: string;
  city?: string;
  state?: string;
}

export interface NormalizedCreateOrderInput {
  routePoints?: RoutePointInput[];
  pickup?: NormalizedLocationInput;
  drop?: NormalizedLocationInput;
  distanceKm: number;
  vehicleRequirements: VehicleRequirement[];
  goodsType?: string;
  cargoWeightKg?: number;
  scheduledAt?: string;
}

interface ResponseUserContext {
  id: string;
  name: string;
  phone: string;
}

type AnyRecord = Record<string, unknown>;

function toRecord(value: unknown): AnyRecord {
  return typeof value === 'object' && value !== null ? (value as AnyRecord) : {};
}

function parseNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new AppError(400, 'VALIDATION_ERROR', `Invalid numeric value for ${field}`);
}

function normalizeLocation(raw: unknown, field: 'pickup' | 'drop'): NormalizedLocationInput {
  const input = toRecord(raw);
  const nestedCoordinates = toRecord(input.coordinates);
  const latitude = parseNumber(
    input.latitude ?? nestedCoordinates.latitude,
    `${field}.latitude`
  );
  const longitude = parseNumber(
    input.longitude ?? nestedCoordinates.longitude,
    `${field}.longitude`
  );
  const address = String(input.address ?? '').trim();

  if (!address) {
    throw new AppError(400, 'VALIDATION_ERROR', `${field}.address is required`);
  }

  const city = typeof input.city === 'string' && input.city.trim().length > 0
    ? input.city.trim()
    : undefined;
  const state = typeof input.state === 'string' && input.state.trim().length > 0
    ? input.state.trim()
    : undefined;

  return { latitude, longitude, address, city, state };
}

function normalizeRoutePoints(raw: unknown): RoutePointInput[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const points = raw.map((entry, index) => {
    const point = toRecord(entry);
    const nestedCoordinates = toRecord(point.coordinates);
    const type = String(point.type ?? '').trim().toUpperCase();
    if (!['PICKUP', 'STOP', 'DROP'].includes(type)) {
      throw new AppError(400, 'VALIDATION_ERROR', `routePoints[${index}].type is invalid`);
    }

    const latitude = parseNumber(
      point.latitude ?? nestedCoordinates.latitude,
      `routePoints[${index}].latitude`
    );
    const longitude = parseNumber(
      point.longitude ?? nestedCoordinates.longitude,
      `routePoints[${index}].longitude`
    );
    const address = String(point.address ?? '').trim();
    if (!address) {
      throw new AppError(400, 'VALIDATION_ERROR', `routePoints[${index}].address is required`);
    }

    const city = typeof point.city === 'string' && point.city.trim().length > 0
      ? point.city.trim()
      : undefined;
    const state = typeof point.state === 'string' && point.state.trim().length > 0
      ? point.state.trim()
      : undefined;

    return {
      type: type as RoutePointInput['type'],
      latitude,
      longitude,
      address,
      city,
      state
    };
  });

  if (points.length < 2) {
    throw new AppError(400, 'VALIDATION_ERROR', 'routePoints must include at least pickup and drop');
  }

  return points;
}

function normalizeVehicleRequirements(raw: unknown): VehicleRequirement[] {
  const input = toRecord(raw);
  const list = Array.isArray(input.vehicleRequirements)
    ? input.vehicleRequirements
    : Array.isArray(input.trucks)
      ? input.trucks
      : [];

  if (list.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'At least one vehicle requirement is required');
  }

  return list.map((item, index) => {
    const requirement = toRecord(item);
    const vehicleType = String(requirement.vehicleType ?? '').trim();
    const vehicleSubtype = String(requirement.vehicleSubtype ?? '').trim();

    if (!vehicleType) {
      throw new AppError(400, 'VALIDATION_ERROR', `vehicleRequirements[${index}].vehicleType is required`);
    }
    if (!vehicleSubtype) {
      throw new AppError(400, 'VALIDATION_ERROR', `vehicleRequirements[${index}].vehicleSubtype is required`);
    }

    const quantity = Math.max(1, Math.floor(parseNumber(requirement.quantity, `vehicleRequirements[${index}].quantity`)));
    const pricePerTruck = parseNumber(requirement.pricePerTruck, `vehicleRequirements[${index}].pricePerTruck`);

    return {
      vehicleType,
      vehicleSubtype,
      quantity,
      pricePerTruck
    };
  });
}

function normalizeCargoWeightKg(raw: unknown): number | undefined {
  const input = toRecord(raw);
  if (input.cargoWeightKg != null) {
    return Math.max(0, Math.floor(parseNumber(input.cargoWeightKg, 'cargoWeightKg')));
  }

  if (typeof input.weight === 'string') {
    const parsed = Number(input.weight.replace(/[^\d.]/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return undefined;
}

function resolvePickupDrop(normalized: NormalizedCreateOrderInput): {
  pickup: NormalizedLocationInput;
  drop: NormalizedLocationInput;
} {
  if (normalized.routePoints && normalized.routePoints.length >= 2) {
    const pickupPoint = normalized.routePoints.find(point => point.type === 'PICKUP') ?? normalized.routePoints[0];
    const dropPoint = normalized.routePoints.find(point => point.type === 'DROP') ?? normalized.routePoints[normalized.routePoints.length - 1];

    return {
      pickup: {
        latitude: pickupPoint.latitude,
        longitude: pickupPoint.longitude,
        address: pickupPoint.address,
        city: pickupPoint.city,
        state: pickupPoint.state
      },
      drop: {
        latitude: dropPoint.latitude,
        longitude: dropPoint.longitude,
        address: dropPoint.address,
        city: dropPoint.city,
        state: dropPoint.state
      }
    };
  }

  if (!normalized.pickup || !normalized.drop) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Either routePoints OR both pickup and drop must be provided'
    );
  }

  return {
    pickup: normalized.pickup,
    drop: normalized.drop
  };
}

export function normalizeCreateOrderInput(raw: unknown): NormalizedCreateOrderInput {
  const input = toRecord(raw);
  const routePoints = normalizeRoutePoints(input.routePoints);
  const pickup = input.pickup != null ? normalizeLocation(input.pickup, 'pickup') : undefined;
  const drop = input.drop != null ? normalizeLocation(input.drop, 'drop') : undefined;
  const distanceKm = Math.max(0, Math.floor(parseNumber(input.distanceKm, 'distanceKm')));
  const vehicleRequirements = normalizeVehicleRequirements(input);
  const goodsType = typeof input.goodsType === 'string' && input.goodsType.trim().length > 0
    ? input.goodsType.trim()
    : undefined;
  const scheduledAt = typeof input.scheduledAt === 'string' && input.scheduledAt.trim().length > 0
    ? input.scheduledAt.trim()
    : undefined;

  if (!routePoints && (!pickup || !drop)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Either routePoints OR both pickup and drop must be provided'
    );
  }

  return {
    routePoints,
    pickup,
    drop,
    distanceKm,
    vehicleRequirements,
    goodsType,
    cargoWeightKg: normalizeCargoWeightKg(input),
    scheduledAt
  };
}

export function toCreateOrderServiceRequest(
  normalized: NormalizedCreateOrderInput,
  user: ResponseUserContext,
  idempotencyKey?: string
): CreateOrderRequest {
  return {
    customerId: user.id,
    customerName: user.name,
    customerPhone: user.phone,
    routePoints: normalized.routePoints,
    pickup: normalized.pickup,
    drop: normalized.drop,
    distanceKm: normalized.distanceKm,
    vehicleRequirements: normalized.vehicleRequirements,
    goodsType: normalized.goodsType,
    cargoWeightKg: normalized.cargoWeightKg,
    scheduledAt: normalized.scheduledAt,
    idempotencyKey
  };
}

export function buildCreateOrderResponseData(
  result: CreateOrderResponse,
  normalized: NormalizedCreateOrderInput,
  user: ResponseUserContext
) {
  const nowIso = new Date().toISOString();
  const resolved = resolvePickupDrop(normalized);

  return {
    order: {
      id: result.orderId,
      customerId: user.id,
      customerName: user.name,
      customerPhone: user.phone,
      pickup: {
        coordinates: {
          latitude: resolved.pickup.latitude,
          longitude: resolved.pickup.longitude
        },
        address: resolved.pickup.address,
        city: resolved.pickup.city,
        state: resolved.pickup.state
      },
      drop: {
        coordinates: {
          latitude: resolved.drop.latitude,
          longitude: resolved.drop.longitude
        },
        address: resolved.drop.address,
        city: resolved.drop.city,
        state: resolved.drop.state
      },
      distanceKm: normalized.distanceKm,
      totalTrucks: result.totalTrucks,
      trucksFilled: 0,
      totalAmount: result.totalAmount,
      goodsType: normalized.goodsType ?? null,
      weight: normalized.cargoWeightKg != null ? `${normalized.cargoWeightKg} kg` : null,
      status: 'active',
      scheduledAt: normalized.scheduledAt ?? null,
      expiresAt: result.expiresAt,
      expiresIn: result.expiresIn,
      createdAt: nowIso,
      updatedAt: nowIso
    },
    truckRequests: result.truckRequests.map((truck, index) => ({
      id: truck.id,
      orderId: result.orderId,
      requestNumber: index + 1,
      vehicleType: truck.vehicleType,
      vehicleSubtype: truck.vehicleSubtype,
      pricePerTruck: truck.pricePerTruck,
      status: 'searching',
      assignedTransporterId: null,
      assignedTransporterName: null,
      assignedVehicleNumber: null,
      assignedDriverName: null,
      assignedDriverPhone: null,
      tripId: null,
      assignedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso
    })),
    broadcastSummary: {
      totalRequests: result.totalTrucks,
      totalTransportersNotified: result.truckRequests.reduce((sum, request) => sum + request.matchingTransporters, 0),
      groupedBy: result.truckRequests.map((request) => ({
        vehicleType: request.vehicleType,
        vehicleSubtype: request.vehicleSubtype,
        count: request.quantity,
        transportersNotified: request.matchingTransporters
      }))
    },
    timeoutSeconds: result.expiresIn
  };
}
