# ⚠️ PROFILE SYSTEM - CRITICAL FILES

## DO NOT MODIFY WITHOUT TESTING

These files are critical for user profile management. Any changes require thorough testing.

---

## Backend Critical Files

### 1. `src/modules/profile/profile.service.ts`
**Purpose:** Core profile business logic
- `getProfile()` - Get user profile by ID
- `updateTransporterProfile()` - Create/update transporter profile
- `updateDriverProfile()` - Create/update driver profile
- `getTransporterDrivers()` - Get drivers linked to transporter
- `addDriver()` - Add driver to transporter's fleet

### 2. `src/modules/profile/profile.routes.ts`
**Purpose:** API route definitions
- `GET /profile` - Get current user's profile (authenticated)
- `PUT /profile/transporter` - Update transporter profile
- `PUT /profile/driver` - Update driver profile
- `GET /profile/drivers` - Get transporter's drivers
- `POST /profile/drivers` - Add driver to fleet
- `DELETE /profile/drivers/:driverId` - Remove driver

### 3. `src/modules/profile/profile.schema.ts`
**Purpose:** Input validation schemas
- `transporterProfileSchema` - Validates transporter profile data
- `driverProfileSchema` - Validates driver profile data
- `addDriverSchema` - Validates add driver request

### 4. `src/shared/database/db.ts`
**Purpose:** Database operations
- `getUserById()` - Get user by ID
- `getUserByPhone()` - Get user by phone + role
- `createUser()` - Create or update user
- `updateUser()` - Update user fields
- `getDriversByTransporter()` - Get drivers for transporter

---

## Android App Critical Files

### 1. `data/api/ProfileApiService.kt`
**Purpose:** Retrofit API interface for profile endpoints
```kotlin
interface ProfileApiService {
    @GET("profile") suspend fun getProfile()
    @PUT("profile/transporter") suspend fun updateTransporterProfile()
    @PUT("profile/driver") suspend fun updateDriverProfile()
    @GET("profile/drivers") suspend fun getTransporterDrivers()
    @POST("profile/drivers") suspend fun addDriver()
}
```
**⚠️ Data classes must match backend response format**

### 2. `data/api/ProfileApiService.kt` - Data Classes
- `UserProfile` - User profile data (matches backend UserRecord)
- `TransporterProfileRequest` - Request body for transporter update
- `DriverProfileRequest` - Request body for driver update
- `DrawerUserProfile` - Profile data for navigation drawer

### 3. `ui/transporter/TransporterProfileScreen.kt`
**Purpose:** Transporter profile view/edit screen
- Fetches profile via `RetrofitClient.profileApi.getProfile()`
- Saves via `RetrofitClient.profileApi.updateTransporterProfile()`
- Fields: name, email, businessName, businessAddress, panNumber, gstNumber

### 4. `ui/driver/DriverProfileScreen.kt`
**Purpose:** Driver profile view/edit screen
- Fetches profile via `RetrofitClient.profileApi.getProfile()`
- Saves via `RetrofitClient.profileApi.updateDriverProfile()`
- Fields: name, email, licenseNumber, licenseExpiry, emergencyContact, address

### 5. `ui/components/NavigationDrawer.kt`
**Purpose:** Navigation drawer with user profile header
- `DrawerUserProfile` - Profile data for drawer display
- `DrawerContentInternal()` - Drawer content composable
- `createTransporterMenuItems()` - Menu items for transporter
- `createDriverMenuItems()` - Menu items for driver

### 6. `ui/transporter/TransporterDashboardScreen.kt`
**Purpose:** Transporter dashboard with drawer
- Fetches profile in `LaunchedEffect`
- Converts `UserProfile` to `DrawerUserProfile`
- Opens drawer on hamburger menu click

---

## Database Schema (UserRecord)

```typescript
interface UserRecord {
  id: string;
  phone: string;
  role: 'customer' | 'transporter' | 'driver';
  name: string;
  email?: string;
  profilePhoto?: string;
  
  // Transporter specific
  businessName?: string;
  businessAddress?: string;
  panNumber?: string;
  gstNumber?: string;
  
  // Driver specific
  transporterId?: string;
  licenseNumber?: string;
  licenseExpiry?: string;
  aadharNumber?: string;
  
  isVerified: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
```

---

## Testing Checklist

Before any deployment, verify:

- [ ] Backend starts without errors
- [ ] `GET /profile` returns current user data
- [ ] `PUT /profile/transporter` saves transporter profile
- [ ] `PUT /profile/driver` saves driver profile
- [ ] Profile appears correctly in navigation drawer
- [ ] Profile edit screens load data correctly
- [ ] Profile saves and shows success message
- [ ] Logout clears tokens and user data

---

## Quick Test Commands

```bash
# Start backend
cd /Users/nitishbhardwaj/Desktop/weelo-backend
npm run dev

# Test get profile (need valid token)
curl -X GET http://localhost:3000/api/v1/profile \
  -H "Authorization: Bearer YOUR_TOKEN"

# Test update transporter profile
curl -X PUT http://localhost:3000/api/v1/profile/transporter \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test User", "company": "Test Company"}'

# Test update driver profile
curl -X PUT http://localhost:3000/api/v1/profile/driver \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Driver", "licenseNumber": "DL123456"}'
```

---

## Field Mapping Notes

| Android Field | Backend Field | Notes |
|--------------|---------------|-------|
| `company` | `businessName` | Both accepted, mapped in service |
| `address` | `businessAddress` | Both accepted, mapped in service |
| `getBusinessDisplayName()` | - | Helper function for display |

---

## Common Issues

| Issue | Solution |
|-------|----------|
| Profile not loading | Check auth token is valid |
| Save fails silently | Check network connection |
| Drawer shows empty profile | Profile API may have failed |
| Fields not saving | Check field names match schema |

---

**Last verified:** 2026-01-10
**Verified by:** Rovo Dev
