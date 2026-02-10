# 🔐 WEELO AUTHENTICATION ARCHITECTURE

## Overview

Weelo has **3 user roles** with **2 separate apps**:

| Role | App | OTP Sent To | Description |
|------|-----|-------------|-------------|
| **Customer** | Weelo (Customer App) | Customer's phone | Creates orders, tracks shipments |
| **Transporter** | Weelo Captain | Transporter's phone | Manages fleet, accepts orders |
| **Driver** | Weelo Captain | **Transporter's phone** | Drives trucks, completes trips |

---

## 🏗️ Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           WEELO BACKEND (AWS)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────┐         ┌─────────────────────┐                   │
│  │   AUTH MODULE       │         │  DRIVER-AUTH MODULE │                   │
│  │  /api/v1/auth/*     │         │ /api/v1/driver-auth/*│                   │
│  ├─────────────────────┤         ├─────────────────────┤                   │
│  │ • Customer OTP      │         │ • Driver OTP        │                   │
│  │ • Transporter OTP   │         │ • OTP → Transporter │                   │
│  │ • OTP → User's phone│         │   (NOT driver!)     │                   │
│  └──────────┬──────────┘         └──────────┬──────────┘                   │
│             │                               │                               │
│             └───────────────┬───────────────┘                               │
│                             │                                               │
│                             ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         REDIS (ElastiCache)                          │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │  OTP Storage:                                                        │   │
│  │  • otp:{phone}:{role}      → Customer/Transporter OTPs              │   │
│  │  • driver-otp:{driverPhone} → Driver OTPs                            │   │
│  │                                                                       │   │
│  │  Token Storage:                                                       │   │
│  │  • refresh:{tokenHash}     → Refresh token tracking                  │   │
│  │  • user:tokens:{userId}    → User's active tokens                    │   │
│  │  • driver:tokens:{driverId}→ Driver's active tokens                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                             │                                               │
│                             ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      POSTGRESQL (RDS)                                │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │  users table:                                                        │   │
│  │  ┌─────────────────────────────────────────────────────────────┐    │   │
│  │  │ id | phone | role | name | transporterId | ... │            │    │   │
│  │  ├─────────────────────────────────────────────────────────────┤    │   │
│  │  │ u1 | 9876543210 | customer | Rahul | NULL | ...            │    │   │
│  │  │ u2 | 9898989898 | transporter | ABC Logistics | NULL | ... │    │   │
│  │  │ u3 | 9123456789 | driver | Ramesh | u2 (transporter) | ... │    │   │
│  │  └─────────────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📱 OTP Flows

### 1️⃣ Customer Login Flow

```
Customer App                    Backend                         Redis
    │                              │                               │
    │ POST /auth/send-otp          │                               │
    │ { phone, role: "customer" }  │                               │
    │────────────────────────────▶│                               │
    │                              │                               │
    │                              │ Generate OTP (6 digits)       │
    │                              │ Hash with bcrypt              │
    │                              │                               │
    │                              │ SET otp:9876543210:customer   │
    │                              │─────────────────────────────▶│
    │                              │ TTL: 5 minutes                │
    │                              │                               │
    │                              │ Send SMS to Customer ────────▶ 📱 Customer
    │                              │                               │
    │◀────────────────────────────│                               │
    │ { success, expiresIn }       │                               │
    │                              │                               │
    │ POST /auth/verify-otp        │                               │
    │ { phone, otp, role }         │                               │
    │────────────────────────────▶│                               │
    │                              │ GET otp:9876543210:customer   │
    │                              │◀─────────────────────────────│
    │                              │                               │
    │                              │ bcrypt.compare(otp, hash)     │
    │                              │                               │
    │                              │ DEL otp:9876543210:customer   │
    │                              │─────────────────────────────▶│
    │                              │                               │
    │                              │ Create/Find user in DB        │
    │                              │ Generate JWT tokens           │
    │                              │                               │
    │◀────────────────────────────│                               │
    │ { accessToken, refreshToken, │                               │
    │   user, isNewUser }          │                               │
```

### 2️⃣ Transporter Login Flow

**Same as Customer**, just with `role: "transporter"`.
OTP is sent to the transporter's own phone.

### 3️⃣ Driver Login Flow (Different!)

```
Captain App (Driver)           Backend                     Redis              Transporter
    │                              │                           │                    │
    │ POST /driver-auth/send-otp   │                           │                    │
    │ { driverPhone }              │                           │                    │
    │────────────────────────────▶│                           │                    │
    │                              │                           │                    │
    │                              │ Find driver by phone      │                    │
    │                              │ Find driver's transporter │                    │
    │                              │                           │                    │
    │                              │ Generate OTP (6 digits)   │                    │
    │                              │ Hash with bcrypt          │                    │
    │                              │                           │                    │
    │                              │ SET driver-otp:912345...  │                    │
    │                              │──────────────────────────▶│                    │
    │                              │ TTL: 5 minutes            │                    │
    │                              │                           │                    │
    │                              │ Send SMS to TRANSPORTER ──────────────────────▶ 📱
    │                              │ (NOT to driver!)          │                    │
    │                              │                           │                    │
    │◀────────────────────────────│                           │                    │
    │ { transporterPhoneMasked,    │                           │                    │
    │   driverName, expiresIn }    │                           │                    │
    │                              │                           │                    │
    │                              │                           │                    │
    │ Driver asks transporter      │                           │           📱──────▶ Driver
    │ for OTP (call/text)          │                           │           (shares OTP)
    │                              │                           │                    │
    │ POST /driver-auth/verify-otp │                           │                    │
    │ { driverPhone, otp }         │                           │                    │
    │────────────────────────────▶│                           │                    │
    │                              │ GET driver-otp:912345...  │                    │
    │                              │◀──────────────────────────│                    │
    │                              │                           │                    │
    │                              │ bcrypt.compare(otp, hash) │                    │
    │                              │                           │                    │
    │                              │ DEL driver-otp:912345...  │                    │
    │                              │──────────────────────────▶│                    │
    │                              │                           │                    │
    │                              │ Generate JWT tokens       │                    │
    │                              │                           │                    │
    │◀────────────────────────────│                           │                    │
    │ { accessToken, refreshToken, │                           │                    │
    │   driver, role: "DRIVER" }   │                           │                    │
```

---

## 🔑 Why Driver OTP Goes to Transporter?

This design ensures:

1. **Authorization**: Only drivers registered by a transporter can login
2. **Control**: Transporters maintain control over who accesses their fleet
3. **Security**: Prevents unauthorized driver access
4. **Audit**: Transporter knows when their drivers are logging in

---

## 📁 File Structure

```
src/modules/
├── auth/                          # Customer & Transporter Auth
│   ├── auth.controller.ts         # HTTP handlers
│   ├── auth.routes.ts             # Route definitions
│   ├── auth.schema.ts             # Zod validation
│   ├── auth.service.ts            # Business logic (Redis-powered)
│   └── sms.service.ts             # SMS provider abstraction
│
└── driver-auth/                   # Driver Auth (separate module)
    ├── driver-auth.controller.ts  # HTTP handlers
    ├── driver-auth.routes.ts      # Route definitions
    ├── driver-auth.schema.ts      # Zod validation
    └── driver-auth.service.ts     # Business logic (Redis-powered)
```

---

## 🔒 Security Features

| Feature | Implementation |
|---------|----------------|
| OTP Generation | `crypto.randomInt()` - cryptographically secure |
| OTP Storage | Hashed with bcrypt (10 rounds) |
| OTP Expiry | 5 minutes (configurable) |
| Max Attempts | 3 attempts before invalidation |
| Rate Limiting | Route-level rate limiting |
| Token Signing | Separate secrets for access & refresh tokens |
| Production | OTPs NEVER logged, only sent via SMS |

---

## 🗄️ Redis Key Patterns

### Customer/Transporter Auth
```
otp:{phone}:{role}           # OTP storage (TTL: 5 min)
refresh:{tokenHash}          # Refresh token tracking
user:tokens:{userId}         # User's active tokens set
```

### Driver Auth
```
driver-otp:{driverPhone}     # Driver OTP storage (TTL: 5 min)
driver-refresh:{tokenHash}   # Driver refresh token tracking
driver:tokens:{driverId}     # Driver's active tokens set
```

---

## 📊 Database Schema (Users Table)

```sql
-- Same phone can have different roles (unique constraint: phone + role)
CREATE TABLE users (
  id           UUID PRIMARY KEY,
  phone        VARCHAR(15) NOT NULL,
  role         user_role NOT NULL,  -- 'customer' | 'transporter' | 'driver'
  name         VARCHAR(255),
  
  -- Driver-specific: which transporter owns this driver
  transporter_id UUID REFERENCES users(id),
  
  -- Other fields...
  
  UNIQUE(phone, role)  -- Same phone can be customer AND transporter
);

-- Indexes for fast lookups
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_transporter ON users(transporter_id);
```

---

## 🧪 Testing OTP Flows

### Development Mode
OTPs are logged to server console in a formatted box:

```
╔══════════════════════════════════════════════════════════════╗
║              🔐 OTP GENERATED (DEV MODE ONLY)                ║
╠══════════════════════════════════════════════════════════════╣
║  Phone:   98****10                                           ║
║  Role:    customer                                           ║
║  OTP:     847291                                             ║
║  Expires: 2:30:00 PM                                         ║
╠══════════════════════════════════════════════════════════════╣
║  ⚠️  This OTP is shown ONLY in development mode!             ║
╚══════════════════════════════════════════════════════════════╝
```

### Test Commands

```bash
# Customer OTP
curl -X POST http://localhost:3000/api/v1/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210", "role": "customer"}'

# Transporter OTP
curl -X POST http://localhost:3000/api/v1/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "9898989898", "role": "transporter"}'

# Driver OTP (goes to transporter!)
curl -X POST http://localhost:3000/api/v1/driver-auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"driverPhone": "9123456789"}'

# Verify OTP
curl -X POST http://localhost:3000/api/v1/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210", "otp": "847291", "role": "customer"}'
```

---

## 🚀 Scalability

This architecture supports **millions of concurrent users**:

1. **Redis** - All OTP storage in Redis (not in-memory)
2. **Stateless JWT** - No session storage on server
3. **Horizontal Scaling** - Any server can handle any request
4. **Auto-cleanup** - Redis TTL automatically removes expired OTPs

---

## 📱 App Integration

### Captain App (Android)
The Captain app uses two API services:

1. **AuthApiService** - For transporter login (`/auth/*`)
2. **DriverAuthApiService** - For driver login (`/driver-auth/*`)

The `AuthViewModel` in the app handles both flows, routing to the correct endpoints based on the selected role.

---

*Last Updated: January 25, 2026*
*Version: 2.0.0 (Redis-powered)*
