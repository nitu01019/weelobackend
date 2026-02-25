import { AppError } from '../../shared/types/error.types';
import { prismaClient } from '../../shared/database/prisma.service';

export interface TripTrackingAccessScope {
  tripId: string;
  assignmentId: string;
  bookingId: string | null;
  orderId: string | null;
  driverId: string;
  transporterId: string;
  bookingCustomerId: string | null;
  orderCustomerId: string | null;
}

export interface BookingTrackingAccessScope {
  bookingId: string;
  assignmentIds: string[];
  tripIds: string[];
}

function isAuthorizedForAssignment(
  role: string,
  userId: string,
  scope: {
    driverId: string;
    transporterId: string;
    bookingCustomerId: string | null;
    orderCustomerId: string | null;
  }
): boolean {
  const normalizedRole = role.toLowerCase();
  if (normalizedRole === 'driver') {
    return scope.driverId === userId;
  }
  if (normalizedRole === 'transporter') {
    return scope.transporterId === userId;
  }
  if (normalizedRole === 'customer') {
    return scope.bookingCustomerId === userId || scope.orderCustomerId === userId;
  }
  return false;
}

export async function assertTripTrackingAccess(
  tripId: string,
  userId: string,
  role: string
): Promise<TripTrackingAccessScope> {
  const assignment = await prismaClient.assignment.findUnique({
    where: { tripId },
    select: {
      id: true,
      tripId: true,
      bookingId: true,
      orderId: true,
      driverId: true,
      transporterId: true,
      booking: {
        select: {
          customerId: true
        }
      },
      order: {
        select: {
          customerId: true
        }
      }
    }
  });

  if (!assignment) {
    throw new AppError(404, 'TRACKING_NOT_FOUND', 'No tracking data for this trip');
  }

  if (!isAuthorizedForAssignment(role, userId, {
    driverId: assignment.driverId,
    transporterId: assignment.transporterId,
    bookingCustomerId: assignment.booking?.customerId ?? null,
    orderCustomerId: assignment.order?.customerId ?? null
  })) {
    throw new AppError(403, 'FORBIDDEN', 'Access denied');
  }

  return {
    tripId: assignment.tripId,
    assignmentId: assignment.id,
    bookingId: assignment.bookingId,
    orderId: assignment.orderId,
    driverId: assignment.driverId,
    transporterId: assignment.transporterId,
    bookingCustomerId: assignment.booking?.customerId ?? null,
    orderCustomerId: assignment.order?.customerId ?? null
  };
}

export async function assertBookingTrackingAccess(
  bookingId: string,
  userId: string,
  role: string
): Promise<BookingTrackingAccessScope> {
  const assignments = await prismaClient.assignment.findMany({
    where: {
      OR: [
        { bookingId },
        { orderId: bookingId }
      ]
    },
    select: {
      id: true,
      tripId: true,
      bookingId: true,
      orderId: true,
      driverId: true,
      transporterId: true,
      booking: {
        select: {
          customerId: true
        }
      },
      order: {
        select: {
          customerId: true
        }
      }
    }
  });

  if (assignments.length === 0) {
    throw new AppError(404, 'TRACKING_NOT_FOUND', 'No tracking data for this booking');
  }

  const authorized = assignments.some((assignment) =>
    isAuthorizedForAssignment(role, userId, {
      driverId: assignment.driverId,
      transporterId: assignment.transporterId,
      bookingCustomerId: assignment.booking?.customerId ?? null,
      orderCustomerId: assignment.order?.customerId ?? null
    })
  );
  if (!authorized) {
    throw new AppError(403, 'FORBIDDEN', 'Access denied');
  }

  return {
    bookingId,
    assignmentIds: assignments.map(assignment => assignment.id),
    tripIds: assignments.map(assignment => assignment.tripId)
  };
}
