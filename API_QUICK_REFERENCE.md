# 🚛 Weelo Logistics - API Quick Reference

## Base URLs

| Environment | URL |
|-------------|-----|
| **Local (Emulator)** | `http://10.0.2.2:3000/api/v1` |
| **Local (Device)** | `http://<YOUR_IP>:3000/api/v1` |
| **Staging** | `https://staging-api.weelo.in/v1` |
| **Production** | `https://api.weelo.in/v1` |

---

## 🔐 Authentication

### Send OTP
```bash
POST /auth/send-otp

# Request
{
  "phone": "9876543210",
  "role": "driver" | "transporter" | "customer"
}

# Response (200)
{
  "success": true,
  "data": {
    "message": "OTP sent successfully",
    "expiresIn": 300,
    "otp": "123456"  // Only in MOCK_MODE
  }
}
```

### Verify OTP
```bash
POST /auth/verify-otp

# Request
{
  "phone": "9876543210",
  "otp": "123456",
  "role": "driver"
}

# Response (200)
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "phone": "9876543210",
      "role": "driver",
      "name": null
    },
    "tokens": {
      "accessToken": "eyJhbG...",
      "refreshToken": "eyJhbG...",
      "expiresIn": 604800
    },
    "isNewUser": true
  }
}
```

### Logout
```bash
POST /auth/logout
Authorization: Bearer {accessToken}

# Response (200)
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

## 🚚 Vehicle Types (Public)

### Get All Vehicle Types
```bash
GET /vehicles/types

# Response (200)
{
  "success": true,
  "data": {
    "types": [
      {
        "type": "open",
        "name": "Open Truck",
        "subtypes": ["14 Feet", "17 Feet", "19 Feet", "22 Feet", "24 Feet", "32 Feet"]
      },
      // ... more types
    ]
  }
}
```

---

## 💰 Pricing (Public)

### Calculate Price Estimate
```bash
GET /pricing/estimate?vehicleType=open&distanceKm=100&trucksNeeded=2

# Response (200)
{
  "success": true,
  "data": {
    "pricing": {
      "vehicleType": "open",
      "distanceKm": 100,
      "trucksNeeded": 2,
      "basePrice": 1500,
      "distanceCharge": 2500,
      "surgeMultiplier": 1.0,
      "pricePerTruck": 4000,
      "totalAmount": 8000,
      "currency": "INR",
      "validForMinutes": 15
    }
  }
}
```

---

## 📦 Bookings (Customer App)

### Create Booking
```bash
POST /bookings
Authorization: Bearer {accessToken}
Content-Type: application/json

# Request
{
  "pickup": {
    "coordinates": { "latitude": 28.6139, "longitude": 77.2090 },
    "address": "New Delhi, India"
  },
  "drop": {
    "coordinates": { "latitude": 19.0760, "longitude": 72.8777 },
    "address": "Mumbai, India"
  },
  "vehicleType": "open",
  "vehicleSubtype": "14 Feet",
  "trucksNeeded": 2,
  "distanceKm": 1400,
  "pricePerTruck": 45000
}

# Response (201)
{
  "success": true,
  "data": {
    "booking": {
      "id": "booking_uuid",
      "customerId": "customer_uuid",
      "status": "BROADCAST",
      "trucksNeeded": 2,
      "trucksFilled": 0,
      "totalAmount": 90000,
      "createdAt": "2026-01-09T...",
      "expiresAt": "2026-01-09T..."
    }
  }
}
```

### Get My Bookings
```bash
GET /bookings?page=1&limit=20&status=ACTIVE
Authorization: Bearer {accessToken}

# Response (200)
{
  "success": true,
  "data": {
    "bookings": [...],
    "total": 10,
    "hasMore": false
  }
}
```

### Get Booking Details
```bash
GET /bookings/{bookingId}
Authorization: Bearer {accessToken}
```

### Cancel Booking
```bash
PATCH /bookings/{bookingId}/cancel
Authorization: Bearer {accessToken}
```

---

## 📡 Broadcasts (Captain App - Transporter)

### Get Active Broadcasts
```bash
GET /broadcasts/active?driverId={id}&vehicleType=open
Authorization: Bearer {accessToken}

# Response (200)
{
  "success": true,
  "broadcasts": [
    {
      "broadcastId": "bc_123",
      "customerName": "ABC Industries",
      "pickupLocation": {...},
      "dropLocation": {...},
      "distance": 1400.0,
      "totalTrucksNeeded": 10,
      "trucksFilledSoFar": 3,
      "vehicleType": "CONTAINER",
      "farePerTruck": 85000.0,
      "status": "ACTIVE",
      "isUrgent": true
    }
  ],
  "count": 5
}
```

### Accept Broadcast
```bash
POST /broadcasts/{broadcastId}/accept
Authorization: Bearer {accessToken}

# Request
{
  "driverId": "driver_123",
  "vehicleId": "vehicle_456",
  "estimatedArrival": "2026-01-05T11:00:00Z"
}

# Response (200)
{
  "success": true,
  "message": "Broadcast accepted successfully",
  "assignmentId": "assign_789",
  "tripId": "trip_101"
}
```

### Decline Broadcast
```bash
POST /broadcasts/{broadcastId}/decline
Authorization: Bearer {accessToken}

# Request
{
  "driverId": "driver_123",
  "reason": "NOT_AVAILABLE",  // or "VEHICLE_NOT_SUITABLE", "DISTANCE_TOO_FAR"
  "notes": "Optional reason"
}
```

---

## 🚗 Driver APIs (Captain App)

### Get Dashboard
```bash
GET /driver/dashboard?driverId={id}
Authorization: Bearer {accessToken}

# Response (200)
{
  "success": true,
  "dashboard": {
    "isAvailable": true,
    "activeTrip": null,
    "todayTrips": 5,
    "todayEarnings": 12500.0,
    "weekEarnings": 62500.0,
    "monthEarnings": 250000.0,
    "rating": 4.5,
    "pendingTrips": []
  }
}
```

### Update Availability
```bash
PUT /driver/availability
Authorization: Bearer {accessToken}

# Request
{
  "driverId": "driver_123",
  "isAvailable": true
}
```

### Get Trip History
```bash
GET /driver/trips/history?driverId={id}&page=1&limit=20
Authorization: Bearer {accessToken}
```

---

## 👤 Profile

### Get Profile
```bash
GET /profile
Authorization: Bearer {accessToken}

# Response (200)
{
  "success": true,
  "data": {
    "profile": {
      "id": "uuid",
      "phone": "9876543210",
      "role": "customer",
      "name": "Test User",
      "email": "test@weelo.in",
      "isProfileComplete": true
    }
  }
}
```

### Update Profile
```bash
PUT /profile
Authorization: Bearer {accessToken}

# Request
{
  "name": "John Doe",
  "email": "john@example.com",
  "company": "ABC Logistics"  // for transporters
}
```

---

## 🔄 Real-time (WebSocket)

### Connect
```javascript
const socket = io('http://localhost:3000', {
  auth: { token: accessToken }
});
```

### Events to Listen
| Event | Description |
|-------|-------------|
| `new_broadcast` | New booking broadcast available |
| `broadcast_updated` | Broadcast details changed |
| `broadcast_assigned` | Driver assigned to trip |
| `trip_status_update` | Trip status changed |
| `location_update` | Driver location updated |

---

## ⚠️ Error Responses

All errors follow this format:
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message"
  }
}
```

### Common Error Codes
| Code | HTTP Status | Description |
|------|-------------|-------------|
| `AUTH_REQUIRED` | 401 | Missing authorization token |
| `AUTH_INVALID` | 401 | Invalid or expired token |
| `OTP_INVALID` | 400 | Invalid OTP |
| `OTP_EXPIRED` | 400 | OTP has expired |
| `VALIDATION_ERROR` | 400 | Invalid request data |
| `NOT_FOUND` | 404 | Resource not found |
| `RATE_LIMITED` | 429 | Too many requests |

---

## 🧪 Testing

### Mock Mode (Development)
```bash
# .env
MOCK_MODE=true
MOCK_OTP=123456
```

Use OTP `123456` for any phone number in development.

### Run Test Script
```bash
cd captain-backend
chmod +x test-all-apis.sh
./test-all-apis.sh
```

---

## 📱 App Configuration

### Android Apps - Update Base URL

**Customer App (Weelo):**
```kotlin
// app/src/main/java/com/weelo/logistics/utils/Constants.kt
const val BASE_URL = "http://YOUR_IP:3000/api/v1/"
```

**Captain App (Weelo Captain):**
```kotlin
// app/src/main/java/com/weelo/logistics/utils/Constants.kt
const val BASE_URL = "http://YOUR_IP:3000/api/v1/"
```

### Find Your Mac IP
```bash
ipconfig getifaddr en0
```
