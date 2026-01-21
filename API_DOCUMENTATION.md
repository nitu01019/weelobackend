# 📚 Weelo Captain Backend API Documentation

**For Transporters & Drivers App**

**Base URL:** `http://localhost:3000/api/v1`

---

## 🔐 Authentication

All protected endpoints require Bearer token in Authorization header:
```
Authorization: Bearer <access_token>
```

### Send OTP
```http
POST /auth/send-otp
Content-Type: application/json

{
  "phone": "9876543210",
  "role": "customer"  // customer | transporter | driver
}
```

**Response (Mock Mode):**
```json
{
  "success": true,
  "data": {
    "message": "OTP sent successfully",
    "expiresIn": 300,
    "otp": "123456"  // Only in mock mode
  }
}
```

### Verify OTP
```http
POST /auth/verify-otp
Content-Type: application/json

{
  "phone": "9876543210",
  "otp": "123456",
  "role": "customer"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "phone": "9876543210",
      "role": "customer"
    },
    "tokens": {
      "accessToken": "jwt...",
      "refreshToken": "jwt...",
      "expiresIn": 604800
    },
    "isNewUser": true
  }
}
```

### Refresh Token
```http
POST /auth/refresh
Content-Type: application/json

{
  "refreshToken": "jwt..."
}
```

---

## 📦 Bookings (Customer App)

### Create Booking
```http
POST /bookings
Authorization: Bearer <token>
Content-Type: application/json

{
  "pickup": {
    "coordinates": { "latitude": 19.0760, "longitude": 72.8777 },
    "address": "Mumbai, Maharashtra"
  },
  "drop": {
    "coordinates": { "latitude": 28.7041, "longitude": 77.1025 },
    "address": "Delhi, NCR"
  },
  "vehicleType": "tipper",
  "vehicleSubtype": "20-24 Ton",
  "trucksNeeded": 5,
  "distanceKm": 1400,
  "pricePerTruck": 35000
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "booking": {
      "id": "uuid",
      "customerId": "uuid",
      "trucksNeeded": 5,
      "trucksFilled": 0,
      "status": "active",
      "expiresAt": "2026-01-09T12:00:00.000Z"
    }
  }
}
```

### Get My Bookings
```http
GET /bookings?page=1&limit=20&status=active
Authorization: Bearer <token>
```

### Get Booking Details
```http
GET /bookings/:id
Authorization: Bearer <token>
```

### Get Assigned Trucks
```http
GET /bookings/:id/trucks
Authorization: Bearer <token>
```

### Cancel Booking
```http
PATCH /bookings/:id/cancel
Authorization: Bearer <token>
```

---

## 🚚 Assignments (Transporter & Driver Apps)

### Create Assignment (Transporter assigns truck)
```http
POST /assignments
Authorization: Bearer <transporter_token>
Content-Type: application/json

{
  "bookingId": "uuid",
  "vehicleId": "uuid",
  "vehicleNumber": "MH12AB1234",
  "driverId": "uuid",
  "driverName": "Ramesh Kumar",
  "driverPhone": "9876543001"
}
```

### Get Active Broadcasts (Transporter sees available bookings)
```http
GET /bookings/active
Authorization: Bearer <transporter_token>
```

### Get My Assignments (Driver)
```http
GET /assignments/driver
Authorization: Bearer <driver_token>
```

### Accept Assignment (Driver)
```http
PATCH /assignments/:id/accept
Authorization: Bearer <driver_token>
```

### Update Status (Driver updates trip progress)
```http
PATCH /assignments/:id/status
Authorization: Bearer <driver_token>
Content-Type: application/json

{
  "status": "en_route_pickup",
  "location": { "latitude": 19.1, "longitude": 72.9 }
}
```

**Status Flow:**
```
pending → driver_accepted → en_route_pickup → at_pickup → in_transit → completed
```

---

## 📍 Tracking (Real-time Location)

### Update Location (Driver)
```http
POST /tracking/update
Authorization: Bearer <driver_token>
Content-Type: application/json

{
  "tripId": "uuid",
  "latitude": 19.0760,
  "longitude": 72.8777,
  "speed": 60,
  "bearing": 45
}
```

### Get Current Location
```http
GET /tracking/:tripId
Authorization: Bearer <token>
```

### Get All Trucks for Booking (Multi-truck view)
```http
GET /tracking/booking/:bookingId
Authorization: Bearer <customer_token>
```

---

## 🚛 Vehicles

### Get Vehicle Types (Public)
```http
GET /vehicles/types
```

**Response:**
```json
{
  "success": true,
  "data": {
    "types": [
      {
        "type": "tipper",
        "displayName": "Tipper",
        "description": "For sand, gravel, construction material",
        "subtypes": [
          { "id": "tipper_10t", "name": "10-12 Ton", "pricePerKm": 22 },
          { "id": "tipper_24t", "name": "20-24 Ton", "pricePerKm": 28 }
        ]
      }
    ]
  }
}
```

### Calculate Pricing (Public)
```http
GET /vehicles/pricing?vehicleType=tipper&distanceKm=1400&trucksNeeded=5
```

**Response:**
```json
{
  "success": true,
  "data": {
    "pricing": {
      "vehicleType": "tipper",
      "distanceKm": 1400,
      "trucksNeeded": 5,
      "pricePerKm": 25,
      "pricePerTruck": 35000,
      "totalAmount": 175000,
      "estimatedDuration": "35 hours"
    }
  }
}
```

### Register Vehicle (Transporter)
```http
POST /vehicles
Authorization: Bearer <transporter_token>
Content-Type: application/json

{
  "vehicleNumber": "MH12AB1234",
  "vehicleType": "tipper",
  "vehicleSubtype": "20-24 Ton",
  "capacityTons": 22
}
```

---

## 🔌 WebSocket Events

**Connection:**
```javascript
const socket = io('http://localhost:3000', {
  auth: { token: accessToken }
});
```

**Events:**
| Event | Direction | Description |
|-------|-----------|-------------|
| `join_booking` | Client → Server | Join booking room for updates |
| `leave_booking` | Client → Server | Leave booking room |
| `update_location` | Client → Server | Driver sends location |
| `booking_updated` | Server → Client | Booking status changed |
| `truck_assigned` | Server → Client | New truck assigned |
| `location_updated` | Server → Client | Driver location update |
| `assignment_status_changed` | Server → Client | Trip status changed |

---

## ⚠️ Error Responses

All errors follow this format:
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": {}  // Optional
  }
}
```

**Common Error Codes:**
| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Invalid input |
| `UNAUTHORIZED` | 401 | Auth required |
| `INVALID_TOKEN` | 401 | Invalid JWT |
| `TOKEN_EXPIRED` | 401 | JWT expired |
| `FORBIDDEN` | 403 | No permission |
| `NOT_FOUND` | 404 | Resource not found |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |

---

## 🧪 Testing with Mock Mode

When `MOCK_MODE=true`:
- OTP is always `123456` (or value of `MOCK_OTP`)
- OTP is returned in API response
- No real SMS is sent

```bash
# Test login flow
curl -X POST http://localhost:3000/api/v1/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210", "role": "customer"}'

curl -X POST http://localhost:3000/api/v1/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210", "otp": "123456", "role": "customer"}'
```
