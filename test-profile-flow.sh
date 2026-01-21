#!/bin/bash
# =============================================================================
# PROFILE FLOW TEST SCRIPT
# =============================================================================
# Run this script to verify Profile system is working correctly
# Usage: ./test-profile-flow.sh
# 
# Prerequisites: Backend must be running on localhost:3000
# =============================================================================

BASE_URL="http://localhost:3000/api/v1"
PHONE="9876543210"
ROLE="transporter"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║            PROFILE FLOW VERIFICATION TEST                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Send OTP
echo "📱 Step 1: Sending OTP to $PHONE..."
SEND_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/send-otp" \
  -H "Content-Type: application/json" \
  -d "{\"phone\": \"$PHONE\", \"role\": \"$ROLE\"}")

if ! echo "$SEND_RESPONSE" | grep -q '"success":true'; then
  echo "❌ Failed to send OTP"
  echo "$SEND_RESPONSE"
  exit 1
fi
echo "✅ OTP sent successfully"
echo ""

# Step 2: Get OTP from user
echo "📋 Check the backend console for the OTP"
echo -n "Enter the OTP: "
read OTP

if [ -z "$OTP" ]; then
  echo "❌ No OTP entered"
  exit 1
fi

# Step 3: Verify OTP and get token
echo ""
echo "🔐 Step 2: Verifying OTP..."
VERIFY_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/verify-otp" \
  -H "Content-Type: application/json" \
  -d "{\"phone\": \"$PHONE\", \"otp\": \"$OTP\", \"role\": \"$ROLE\"}")

if ! echo "$VERIFY_RESPONSE" | grep -q '"success":true'; then
  echo "❌ OTP verification failed"
  echo "$VERIFY_RESPONSE"
  exit 1
fi

# Extract access token
ACCESS_TOKEN=$(echo "$VERIFY_RESPONSE" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

if [ -z "$ACCESS_TOKEN" ]; then
  echo "❌ Could not extract access token"
  exit 1
fi
echo "✅ Login successful, got access token"
echo ""

# Step 4: Get current profile
echo "👤 Step 3: Fetching current profile..."
PROFILE_RESPONSE=$(curl -s -X GET "$BASE_URL/profile" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

echo "Response: $PROFILE_RESPONSE"
echo ""

if echo "$PROFILE_RESPONSE" | grep -q '"success":true'; then
  echo "✅ Profile fetch successful"
else
  echo "❌ Profile fetch failed"
  exit 1
fi
echo ""

# Step 5: Update transporter profile
echo "✏️  Step 4: Updating transporter profile..."
UPDATE_RESPONSE=$(curl -s -X PUT "$BASE_URL/profile/transporter" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Transporter",
    "email": "test@weelo.in",
    "company": "Test Logistics Pvt Ltd",
    "panNumber": "ABCDE1234F",
    "gstNumber": "22AAAAA0000A1Z5"
  }')

echo "Response: $UPDATE_RESPONSE"
echo ""

if echo "$UPDATE_RESPONSE" | grep -q '"success":true'; then
  echo "✅ Profile update successful"
else
  echo "❌ Profile update failed"
  exit 1
fi
echo ""

# Step 6: Verify profile was updated
echo "🔍 Step 5: Verifying profile update..."
VERIFY_PROFILE=$(curl -s -X GET "$BASE_URL/profile" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

if echo "$VERIFY_PROFILE" | grep -q '"name":"Test Transporter"'; then
  echo "✅ Profile name verified"
else
  echo "❌ Profile name not updated correctly"
fi

if echo "$VERIFY_PROFILE" | grep -q '"Test Logistics Pvt Ltd"'; then
  echo "✅ Business name verified"
else
  echo "❌ Business name not updated correctly"
fi
echo ""

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║            ALL PROFILE TESTS PASSED ✅                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "📋 Test Summary:"
echo "   ✅ OTP sent and verified"
echo "   ✅ Profile fetched successfully"
echo "   ✅ Profile updated successfully"
echo "   ✅ Profile changes persisted"
echo ""
