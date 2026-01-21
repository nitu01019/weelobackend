# Weelo Integration Status

## Overview
This document summarizes the integration status between:
- **Weelo Backend** (`Desktop/weelo-backend`)
- **Weelo Captain App** (`Desktop/weelo captain`) - For Transporters & Drivers
- **Weelo Customer App** (`Desktop/Weelo`) - For Customers

## ✅ Completed Integrations

### 1. FCM Push Notifications (Backend)
- **File**: `src/shared/services/fcm.service.ts`
- **Features**:
  - Push notifications for new broadcasts
  - Assignment status updates
  - Payment notifications
  - Mock mode for development (logs to console)
- **Endpoint**: `POST /api/v1/notifications/register-token`

### 2. Socket.IO Real-time Communication
- **Backend**: `src/shared/services/socket.service.ts`
- **Captain App**: `data/remote/SocketIOService.kt`
- **Customer App**: `data/remote/WebSocketService.kt`
- **Events**:
  - `new_broadcast` - New booking request
  - `booking_updated` - Status changes
  - `truck_assigned` - Assignment confirmation
  - `assignment_status_changed` - Trip updates

### 3. API URL Configuration

#### Development (Android Emulator)
```
Base URL: http://10.0.2.2:3000/api/v1/
Socket URL: http://10.0.2.2:3000
```

#### Development (Physical Device)
Update IP in these files to your Mac's IP:
- Captain App: `utils/Constants.kt` → `DEVICE_URL`
- Customer App: `data/remote/ApiConfig.kt` → `LOCAL_DEVICE`

#### Production
```
Base URL: https://api.weelo.in/api/v1/
Socket URL: wss://api.weelo.in
```

### 4. Broadcast Acceptance Flow
Complete end-to-end flow:

```
Customer App                    Backend                      Captain App
     |                            |                               |
     |-- Create Booking --------->|                               |
     |                            |-- WebSocket: new_broadcast -->|
     |                            |-- FCM Push Notification ----->|
     |                            |                               |
     |                            |<-- Accept Broadcast ----------|
     |                            |                               |
     |<-- WebSocket: truck_assigned|                              |
     |                            |-- WebSocket: assignment_status|
```

## API Endpoints Summary

### Auth Module (`/api/v1/auth`)
- `POST /send-otp` - Request OTP
- `POST /verify-otp` - Verify OTP and login
- `POST /refresh-token` - Refresh JWT token

### Profile Module (`/api/v1/profile`)
- `GET /` - Get user profile
- `POST /` - Create profile
- `PUT /` - Update profile

### Booking Module (`/api/v1/bookings`)
- `POST /` - Create booking (Customer)
- `GET /my-bookings` - Get customer's bookings
- `GET /:id` - Get booking details
- `POST /:id/cancel` - Cancel booking

### Broadcast Module (`/api/v1/broadcasts`)
- `GET /active` - Get active broadcasts (Driver/Transporter)
- `GET /:id` - Get broadcast details
- `POST /:id/accept` - Accept broadcast
- `POST /:id/decline` - Decline broadcast

### Assignment Module (`/api/v1/assignments`)
- `POST /` - Create assignment (Transporter)
- `GET /` - Get assignments
- `PUT /:id/status` - Update assignment status

### Notification Module (`/api/v1/notifications`)
- `POST /register-token` - Register FCM token
- `DELETE /unregister-token` - Remove FCM token
- `GET /preferences` - Get notification preferences
- `PUT /preferences` - Update preferences

### Vehicle Module (`/api/v1/vehicles`)
- `GET /` - Get vehicles
- `POST /` - Add vehicle
- `GET /types` - Get vehicle types

### Pricing Module (`/api/v1/pricing`)
- `POST /estimate` - Get fare estimate

## Running the System

### 1. Start Backend
```bash
cd Desktop/weelo-backend
npm install
npm run dev
```

### 2. Run Captain App (Android Studio)
```bash
cd "Desktop/weelo captain"
./gradlew assembleDebug
# Or open in Android Studio and run
```

### 3. Run Customer App (Android Studio)
```bash
cd Desktop/Weelo
./gradlew assembleDebug
# Or open in Android Studio and run
```

## Environment Configuration

### Backend (.env)
```env
PORT=3000
NODE_ENV=development
JWT_SECRET=your-jwt-secret
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json  # Optional
```

### For FCM (Optional)
1. Create Firebase project
2. Download service account JSON
3. Set `FIREBASE_SERVICE_ACCOUNT_PATH` in `.env`

Without Firebase config, FCM runs in mock mode (logs to console).

## Testing the Integration

### 1. Test Auth Flow
```bash
# Send OTP
curl -X POST http://localhost:3000/api/v1/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210", "role": "transporter"}'

# Check backend console for OTP
# Verify OTP
curl -X POST http://localhost:3000/api/v1/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210", "otp": "123456"}'
```

### 2. Test Booking Flow
1. Login as Customer in Customer App
2. Create a booking
3. Login as Transporter in Captain App
4. See broadcast appear in real-time
5. Accept broadcast
6. Customer sees truck assigned

## Known Limitations
- FCM requires Firebase project setup for real push notifications
- In development, use mock mode which logs to console
- Physical device testing requires updating IP addresses

## Next Steps
- [ ] Set up Firebase project for production FCM
- [ ] Add SSL certificates for production HTTPS
- [ ] Configure production database (PostgreSQL)
- [ ] Set up CI/CD pipeline
