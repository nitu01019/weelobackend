# ⚠️ OTP AUTHENTICATION - CRITICAL FILES

## DO NOT MODIFY WITHOUT TESTING

These files are critical for OTP authentication. Any changes require running `./test-otp-flow.sh` to verify the flow still works.

---

## Backend Critical Files

### 1. `src/modules/auth/auth.service.ts`
**Purpose:** Core OTP generation and verification logic
- `sendOtp()` - Generates OTP, stores it, logs to console
- `verifyOtp()` - Validates OTP, creates/finds user, returns JWT tokens
- **CRITICAL:** OTP is logged in a formatted box (lines 73-82)

### 2. `src/modules/auth/auth.controller.ts`
**Purpose:** HTTP request handlers for auth endpoints
- `POST /auth/send-otp` - Calls `authService.sendOtp()`
- `POST /auth/verify-otp` - Calls `authService.verifyOtp()`

### 3. `src/modules/auth/auth.routes.ts`
**Purpose:** Route definitions
- `/send-otp` - Public endpoint
- `/verify-otp` - Public endpoint

### 4. `src/modules/auth/sms.service.ts`
**Purpose:** SMS provider abstraction
- `ConsoleProvider` - Logs OTP (development)
- `TwilioProvider` - Sends via Twilio (production)
- `MSG91Provider` - Sends via MSG91 (production)

---

## Android App Critical Files

### 1. `utils/Constants.kt`
**Purpose:** API URL configuration
```kotlin
object API {
    const val EMULATOR_URL = "http://10.0.2.2:3000/api/v1/"
    const val DEVICE_URL = "http://YOUR_IP:3000/api/v1/"
    const val BASE_URL = DEVICE_URL  // or EMULATOR_URL
}
```
**⚠️ Change BASE_URL based on testing device**

### 2. `data/api/AuthApiService.kt`
**Purpose:** Retrofit API interface
- `sendOTP(request)` - POST /auth/send-otp
- `verifyOTP(request)` - POST /auth/verify-otp
- `SendOTPRequest` - phone, role
- `VerifyOTPRequest` - phone, otp, role

### 3. `data/remote/RetrofitClient.kt`
**Purpose:** Network client setup
- `authApi` - Auth service instance
- `saveTokens()` - Store JWT after login
- `saveUserInfo()` - Store user ID and role

### 4. `ui/auth/LoginScreen.kt`
**Purpose:** Phone number input and OTP request
- Sends 10-digit phone (NO +91 prefix)
- Role in lowercase ("transporter" or "driver")
- Navigates to OTP screen on success

### 5. `ui/auth/OTPVerificationScreen.kt`
**Purpose:** OTP input and verification
- Auto-verifies when 6 digits entered
- Calls `RetrofitClient.authApi.verifyOTP()`
- Saves tokens on success
- Has resend OTP functionality

---

## Testing Checklist

Before any deployment, verify:

- [ ] Backend starts without errors: `npm run dev`
- [ ] OTP appears in console when requested
- [ ] Wrong OTP is rejected
- [ ] Correct OTP returns tokens
- [ ] App can connect to backend (check IP address)
- [ ] Login flow completes successfully

---

## Quick Test Commands

```bash
# Start backend
cd /Users/nitishbhardwaj/Desktop/weelo-backend
npm run dev

# Test send OTP
curl -X POST http://localhost:3000/api/v1/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210", "role": "transporter"}'

# Test verify OTP (use OTP from console)
curl -X POST http://localhost:3000/api/v1/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210", "otp": "YOUR_OTP", "role": "transporter"}'
```

---

## Common Issues

| Issue | Solution |
|-------|----------|
| App shows "Network error" | Check BASE_URL in Constants.kt matches your IP |
| OTP not in console | Backend not running or wrong endpoint |
| "Invalid OTP" error | OTP expired (5 min) or wrong code |
| Loading forever | Check phone/Mac on same WiFi |

---

**Last verified:** 2026-01-10
**Verified by:** Rovo Dev
