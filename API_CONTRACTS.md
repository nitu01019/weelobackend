# 📋 WEELO API CONTRACTS

**Version:** 2.0.0  
**Base URL:** `/api/v1`

---

## 🔐 Authentication

All protected endpoints require:
```
Authorization: Bearer <access_token>
```

---

## 📚 API MODULES

### 1. AUTH MODULE (`/api/v1/auth`)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| POST | `/send-otp` | Public | Send OTP to phone |
| POST | `/verify-otp` | Public | Verify OTP, get tokens |
| POST | `/refresh` | Public | Refresh access token |
| POST | `/logout` | Private | Invalidate tokens |
| GET | `/me` | Private | Get current user |

#### POST `/auth/send-otp`
```json
// Request
{
  "phone": "+919876543210",
  "role": "customer" | "transporter" | "driver"
}

// Response
{
  "success": true,
  "data": {
    "expiresIn": 300,
    "message": "OTP sent to +919876543210"
  }
}
```

#### POST `/auth/verify-otp`
```json
// Request
{
  "phone": "+919876543210",
  "otp": "123456",
  "role": "customer"
}

// Response
{
  "success": true,
  "data": {
    "user": { "id": "uuid", "phone": "...", "role": "..." },
    "accessToken": "jwt...",
    "refreshToken": "jwt...",
    "expiresIn": 604800
  }
}
```

---

### 2. PROFILE MODULE (`/api/v1/profile`)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/` | Private | Get my profile |
| PUT | `/customer` | Customer | Update customer profile |
| PUT | `/transporter` | Transporter | Update transporter profile |
| PUT | `/driver` | Driver | Update driver profile |
| POST | `/transporter/drivers` | Transporter | Add driver to fleet |

#### PUT `/profile/customer`
```json
// Request
{
  "name": "John Doe",
  "email": "john@example.com",
  "company": "ABC Corp",
  "gstNumber": "22AAAAA0000A1Z5"
}
```

#### PUT `/profile/transporter`
```json
// Request
{
  "name": "Fleet Owner",
  "email": "fleet@example.com",
  "businessName": "XYZ Logistics",
  "businessAddress": "123 Main St",
  "panNumber": "ABCDE1234F",
  "gstNumber": "22AAAAA0000A1Z5"
}
```

---

### 3. VEHICLE MODULE (`/api/v1/vehicles`)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| POST | `/` | Transporter | Register new vehicle |
| GET | `/` | Transporter | List my vehicles |
| GET | `/:id` | Transporter | Get vehicle details |
| PUT | `/:id` | Transporter | Update vehicle |
| DELETE | `/:id` | Transporter | Remove vehicle |
| GET | `/types` | Public | Get vehicle types catalog |

#### POST `/vehicles`
```json
// Request
{
  "vehicleType": "tipper",
  "vehicleSubtype": "20-24 Ton",
  "registrationNumber": "MH12AB1234",
  "capacity": "24 Ton",
  "rcDocument": "base64...",
  "insuranceDocument": "base64...",
  "insuranceExpiry": "2025-12-31"
}
```

---

### 4. BOOKING MODULE (`/api/v1/bookings`)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| POST | `/` | Customer | Create booking |
| GET | `/` | Customer | My bookings |
| GET | `/active` | Transporter | Active broadcasts |
| GET | `/:id` | Auth | Booking details |
| GET | `/:id/trucks` | Auth | Assigned trucks |
| PATCH | `/:id/cancel` | Customer | Cancel booking |

#### POST `/bookings`
```json
// Request
{
  "pickup": {
    "address": "123 Main St, Mumbai",
    "latitude": 19.0760,
    "longitude": 72.8777
  },
  "drop": {
    "address": "456 Park Ave, Pune",
    "latitude": 18.5204,
    "longitude": 73.8567
  },
  "vehicleType": "tipper",
  "vehicleSubtype": "20-24 Ton",
  "trucksNeeded": 3,
  "scheduledAt": "2025-01-15T10:00:00Z",
  "notes": "Fragile goods"
}
```

---

### 5. ASSIGNMENT MODULE (`/api/v1/assignments`)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| POST | `/` | Transporter | Create assignment |
| GET | `/` | Transporter | My assignments |
| GET | `/:id` | Auth | Assignment details |
| PATCH | `/:id/accept` | Driver | Accept assignment |
| PATCH | `/:id/reject` | Driver | Reject assignment |
| PATCH | `/:id/status` | Driver | Update status |

---

### 6. TRACKING MODULE (`/api/v1/tracking`)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| POST | `/update` | Driver | Update location |
| GET | `/:tripId` | Auth | Get trip location |
| GET | `/booking/:bookingId` | Customer | All trucks for booking |
| GET | `/history/:tripId` | Auth | Location history |

#### POST `/tracking/update`
```json
// Request
{
  "tripId": "uuid",
  "latitude": 19.0760,
  "longitude": 72.8777,
  "heading": 45,
  "speed": 60
}
```

---

### 7. PRICING MODULE (`/api/v1/pricing`)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| POST | `/estimate` | Auth | Get price estimate |
| GET | `/catalog` | Public | Vehicle pricing catalog |

#### POST `/pricing/estimate`
```json
// Request
{
  "vehicleType": "tipper",
  "vehicleSubtype": "20-24 Ton",
  "distanceKm": 150,
  "trucksNeeded": 3
}

// Response
{
  "success": true,
  "data": {
    "pricePerTruck": 8500,
    "totalPrice": 25500,
    "breakdown": {
      "baseFare": 2500,
      "distanceCharge": 5250,
      "gst": 450,
      "platformFee": 300
    },
    "currency": "INR",
    "validForMinutes": 15
  }
}
```

---

### 8. DRIVER MODULE (`/api/v1/driver`)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/dashboard` | Driver | Dashboard stats |
| GET | `/availability` | Driver | Get status |
| PUT | `/availability` | Driver | Update status |
| GET | `/earnings` | Driver | Earnings summary |
| GET | `/trips` | Driver | Trip history |
| GET | `/trips/active` | Driver | Current trip |

---

### 9. BROADCAST MODULE (`/api/v1/broadcasts`)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/` | Transporter | Available broadcasts |
| GET | `/:id` | Transporter | Broadcast details |
| POST | `/:id/accept` | Transporter | Accept broadcast |
| POST | `/:id/reject` | Transporter | Reject broadcast |

---

## 📐 Standard Response Format

### Success Response
```json
{
  "success": true,
  "data": { ... },
  "message": "Optional message"
}
```

### Error Response
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": { ... }
  }
}
```

### Paginated Response
```json
{
  "success": true,
  "data": {
    "items": [...],
    "pagination": {
      "total": 100,
      "limit": 20,
      "offset": 0,
      "hasMore": true
    }
  }
}
```

---

## 🚨 Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Invalid input |
| `UNAUTHORIZED` | 401 | Not authenticated |
| `FORBIDDEN` | 403 | Not authorized |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Resource conflict |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server error |

---

## 🔄 WebSocket Events

### Connect
```javascript
const socket = io('http://localhost:3000', {
  auth: { token: 'jwt...' }
});
```

### Events
| Event | Direction | Description |
|-------|-----------|-------------|
| `booking:new` | Server→Client | New booking available |
| `booking:assigned` | Server→Client | Truck assigned |
| `location:update` | Client→Server | Driver location |
| `location:updated` | Server→Client | Location broadcast |
| `trip:status` | Both | Trip status change |
