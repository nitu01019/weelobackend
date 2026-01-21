#!/bin/bash

# =============================================================================
# WEELO BROADCAST FLOW TEST SCRIPT
# =============================================================================
# 
# This script tests the complete broadcast flow:
# 1. Creates a transporter with vehicles
# 2. Creates a customer
# 3. Customer creates a booking
# 4. Verifies transporter receives the broadcast
# 
# USAGE:
#   cd Desktop/weelo-backend
#   chmod +x test-broadcast-flow.sh
#   ./test-broadcast-flow.sh
#
# PREREQUISITES:
#   - Backend running: npm run dev
#   - curl and jq installed
#
# =============================================================================

set -e

# Configuration
BASE_URL="${BASE_URL:-http://localhost:3000/api/v1}"
TRANSPORTER_PHONE="9876543210"
CUSTOMER_PHONE="9123456789"
OTP="123456"  # In dev mode, any 6-digit OTP works OR check server console

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  WEELO BROADCAST FLOW TEST                                   ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Testing: Customer → Backend → Transporter broadcast flow    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "\n${YELLOW}Base URL: $BASE_URL${NC}\n"

# =============================================================================
# STEP 1: Register Transporter
# =============================================================================
echo -e "${BLUE}[STEP 1] Registering Transporter...${NC}"

# Send OTP to transporter
echo "  → Sending OTP to transporter ($TRANSPORTER_PHONE)..."
SEND_OTP_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/send-otp" \
  -H "Content-Type: application/json" \
  -d "{\"phone\": \"$TRANSPORTER_PHONE\", \"role\": \"transporter\"}")

echo "  ← Response: $SEND_OTP_RESPONSE"

# Wait for OTP (in dev, check console)
echo -e "  ${YELLOW}💡 Check backend console for OTP${NC}"
sleep 1

# Verify OTP for transporter (in dev mode, OTP is shown in console)
echo "  → Verifying OTP..."
echo -e "  ${YELLOW}📝 Enter the OTP from backend console (or press Enter to use test flow):${NC}"
read -r USER_OTP
OTP=${USER_OTP:-$OTP}

VERIFY_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/verify-otp" \
  -H "Content-Type: application/json" \
  -d "{\"phone\": \"$TRANSPORTER_PHONE\", \"role\": \"transporter\", \"otp\": \"$OTP\"}")

echo "  ← Response: $VERIFY_RESPONSE"

TRANSPORTER_TOKEN=$(echo $VERIFY_RESPONSE | jq -r '.data.accessToken // empty')
TRANSPORTER_ID=$(echo $VERIFY_RESPONSE | jq -r '.data.user.id // empty')

if [ -z "$TRANSPORTER_TOKEN" ]; then
  echo -e "${RED}❌ Failed to get transporter token${NC}"
  echo "Response: $VERIFY_RESPONSE"
  exit 1
fi

echo -e "${GREEN}✅ Transporter registered: $TRANSPORTER_ID${NC}"

# =============================================================================
# STEP 2: Register Vehicle for Transporter
# =============================================================================
echo -e "\n${BLUE}[STEP 2] Registering vehicle for transporter...${NC}"

VEHICLE_RESPONSE=$(curl -s -X POST "$BASE_URL/vehicles" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TRANSPORTER_TOKEN" \
  -d '{
    "vehicleNumber": "MH12AB1234",
    "vehicleType": "open",
    "vehicleSubtype": "17_feet",
    "capacity": "9 Ton",
    "model": "Tata LPT 1613"
  }')

echo "  ← Response: $VEHICLE_RESPONSE"

VEHICLE_ID=$(echo $VEHICLE_RESPONSE | jq -r '.data.vehicle.id // empty')

if [ -z "$VEHICLE_ID" ]; then
  echo -e "${YELLOW}⚠️ Vehicle registration returned empty ID (may already exist)${NC}"
else
  echo -e "${GREEN}✅ Vehicle registered: $VEHICLE_ID${NC}"
fi

# =============================================================================
# STEP 3: Register Customer
# =============================================================================
echo -e "\n${BLUE}[STEP 3] Registering Customer...${NC}"

# Send OTP to customer
echo "  → Sending OTP to customer ($CUSTOMER_PHONE)..."
curl -s -X POST "$BASE_URL/auth/send-otp" \
  -H "Content-Type: application/json" \
  -d "{\"phone\": \"$CUSTOMER_PHONE\", \"role\": \"customer\"}" > /dev/null

echo -e "  ${YELLOW}💡 Check backend console for customer OTP${NC}"
sleep 1

echo -e "  ${YELLOW}📝 Enter the customer OTP from backend console:${NC}"
read -r CUSTOMER_OTP
CUSTOMER_OTP=${CUSTOMER_OTP:-$OTP}

# Verify OTP for customer
CUSTOMER_VERIFY=$(curl -s -X POST "$BASE_URL/auth/verify-otp" \
  -H "Content-Type: application/json" \
  -d "{\"phone\": \"$CUSTOMER_PHONE\", \"role\": \"customer\", \"otp\": \"$CUSTOMER_OTP\"}")

echo "  ← Response: $CUSTOMER_VERIFY"

CUSTOMER_TOKEN=$(echo $CUSTOMER_VERIFY | jq -r '.data.accessToken // empty')
CUSTOMER_ID=$(echo $CUSTOMER_VERIFY | jq -r '.data.user.id // empty')

if [ -z "$CUSTOMER_TOKEN" ]; then
  echo -e "${RED}❌ Failed to get customer token${NC}"
  exit 1
fi

echo -e "${GREEN}✅ Customer registered: $CUSTOMER_ID${NC}"

# =============================================================================
# STEP 4: Customer Creates Booking (This triggers broadcast!)
# =============================================================================
echo -e "\n${BLUE}[STEP 4] Customer creating booking (BROADCAST TRIGGER!)...${NC}"

BOOKING_RESPONSE=$(curl -s -X POST "$BASE_URL/bookings" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CUSTOMER_TOKEN" \
  -d '{
    "pickup": {
      "coordinates": { "latitude": 28.6139, "longitude": 77.2090 },
      "address": "Connaught Place, New Delhi",
      "city": "New Delhi",
      "state": "Delhi"
    },
    "drop": {
      "coordinates": { "latitude": 28.5355, "longitude": 77.3910 },
      "address": "Sector 62, Noida",
      "city": "Noida",
      "state": "Uttar Pradesh"
    },
    "vehicleType": "open",
    "vehicleSubtype": "17_feet",
    "trucksNeeded": 2,
    "distanceKm": 25,
    "pricePerTruck": 5000,
    "goodsType": "Electronics",
    "weight": "5 tons"
  }')

echo "  ← Response:"
echo "$BOOKING_RESPONSE" | jq '.'

BOOKING_ID=$(echo $BOOKING_RESPONSE | jq -r '.data.booking.id // empty')
MATCHING_TRANSPORTERS=$(echo $BOOKING_RESPONSE | jq -r '.data.booking.matchingTransportersCount // 0')

if [ -z "$BOOKING_ID" ]; then
  echo -e "${RED}❌ Failed to create booking${NC}"
  exit 1
fi

echo -e "${GREEN}✅ Booking created: $BOOKING_ID${NC}"
echo -e "${GREEN}📢 Broadcasted to: $MATCHING_TRANSPORTERS transporter(s)${NC}"

# =============================================================================
# STEP 5: Verify Transporter Receives Broadcast
# =============================================================================
echo -e "\n${BLUE}[STEP 5] Verifying transporter can see the broadcast...${NC}"

BROADCASTS_RESPONSE=$(curl -s -X GET "$BASE_URL/broadcasts/active?driverId=$TRANSPORTER_ID" \
  -H "Authorization: Bearer $TRANSPORTER_TOKEN")

echo "  ← Active broadcasts for transporter:"
echo "$BROADCASTS_RESPONSE" | jq '.'

BROADCAST_COUNT=$(echo $BROADCASTS_RESPONSE | jq '.broadcasts | length')

if [ "$BROADCAST_COUNT" -gt 0 ]; then
  echo -e "${GREEN}✅ SUCCESS! Transporter can see $BROADCAST_COUNT active broadcast(s)${NC}"
else
  echo -e "${YELLOW}⚠️ No broadcasts visible (may need matching vehicle type)${NC}"
fi

# =============================================================================
# SUMMARY
# =============================================================================
echo -e "\n${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  TEST SUMMARY                                                ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo -e "║  Transporter ID:  ${GREEN}$TRANSPORTER_ID${BLUE}"
echo -e "║  Customer ID:     ${GREEN}$CUSTOMER_ID${BLUE}"
echo -e "║  Booking ID:      ${GREEN}$BOOKING_ID${BLUE}"
echo -e "║  Transporters:    ${GREEN}$MATCHING_TRANSPORTERS notified${BLUE}"
echo -e "║  Broadcasts seen: ${GREEN}$BROADCAST_COUNT${BLUE}"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  NEXT STEPS:                                                 ║"
echo "║  1. Open Captain App on transporter phone                   ║"
echo "║  2. Login with: $TRANSPORTER_PHONE                          ║"
echo "║  3. Go to 'Available Broadcasts' screen                     ║"
echo "║  4. You should see the booking from customer!               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Optional: Keep polling for updates
echo -e "\n${YELLOW}Press Ctrl+C to exit, or wait to see if booking expires...${NC}"
echo "Polling for booking status updates..."

for i in {1..10}; do
  sleep 30
  echo -e "\n[Checking booking status - attempt $i]"
  STATUS=$(curl -s -X GET "$BASE_URL/bookings/$BOOKING_ID" \
    -H "Authorization: Bearer $CUSTOMER_TOKEN" | jq -r '.data.booking.status // "unknown"')
  echo "  Booking status: $STATUS"
  
  if [ "$STATUS" == "expired" ] || [ "$STATUS" == "fully_filled" ]; then
    echo -e "${YELLOW}Booking ended with status: $STATUS${NC}"
    break
  fi
done

echo -e "\n${GREEN}Test complete!${NC}"
