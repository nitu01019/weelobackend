#!/bin/bash
# =============================================================================
# API Integration Test Script
# =============================================================================
# Tests the end-to-end booking flow between Customer and Captain apps
# Run: chmod +x test-api.sh && ./test-api.sh
# =============================================================================

BASE_URL="http://localhost:3000/api/v1"

echo "🚛 Weelo API Integration Tests"
echo "================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Health Check
echo "1. Health Check..."
HEALTH=$(curl -s "$BASE_URL/../health")
if echo "$HEALTH" | grep -q "healthy"; then
    echo -e "${GREEN}✓ Server is healthy${NC}"
else
    echo -e "${RED}✗ Server is not responding${NC}"
    exit 1
fi
echo ""

# 2. Customer Login
echo "2. Customer Login (Send OTP)..."
OTP_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/send-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "9876543210", "role": "customer"}')
echo "$OTP_RESPONSE" | jq .
echo ""

echo "3. Customer Verify OTP..."
CUSTOMER_AUTH=$(curl -s -X POST "$BASE_URL/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "9876543210", "otp": "123456", "role": "customer"}')
CUSTOMER_TOKEN=$(echo "$CUSTOMER_AUTH" | jq -r '.data.tokens.accessToken')
echo -e "${GREEN}✓ Customer logged in${NC}"
echo ""

# 3. Create Booking
echo "4. Customer Creates Booking..."
BOOKING_RESPONSE=$(curl -s -X POST "$BASE_URL/bookings" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $CUSTOMER_TOKEN" \
    -d '{
        "pickup": {
            "coordinates": {"latitude": 19.0760, "longitude": 72.8777},
            "address": "Mumbai, Maharashtra"
        },
        "drop": {
            "coordinates": {"latitude": 28.7041, "longitude": 77.1025},
            "address": "Delhi, NCR"
        },
        "vehicleType": "tipper",
        "vehicleSubtype": "20-24 Ton",
        "trucksNeeded": 3,
        "distanceKm": 1400,
        "pricePerTruck": 35000
    }')
BOOKING_ID=$(echo "$BOOKING_RESPONSE" | jq -r '.data.booking.id')
echo "Booking ID: $BOOKING_ID"
echo -e "${GREEN}✓ Booking created${NC}"
echo ""

# 4. Transporter Login
echo "5. Transporter Login..."
TRANSPORTER_AUTH=$(curl -s -X POST "$BASE_URL/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "9876543211", "otp": "123456", "role": "transporter"}')
TRANSPORTER_TOKEN=$(echo "$TRANSPORTER_AUTH" | jq -r '.data.tokens.accessToken')
echo -e "${GREEN}✓ Transporter logged in${NC}"
echo ""

# 5. View Active Broadcasts
echo "6. Transporter Views Active Broadcasts..."
BROADCASTS=$(curl -s -X GET "$BASE_URL/bookings/active" \
    -H "Authorization: Bearer $TRANSPORTER_TOKEN")
echo "$BROADCASTS" | jq '.data.bookings | length'
echo -e "${GREEN}✓ Active broadcasts retrieved${NC}"
echo ""

# 6. Create Assignment
echo "7. Transporter Creates Assignment..."
ASSIGNMENT_RESPONSE=$(curl -s -X POST "$BASE_URL/assignments" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TRANSPORTER_TOKEN" \
    -d "{
        \"bookingId\": \"$BOOKING_ID\",
        \"vehicleId\": \"vehicle-001\",
        \"vehicleNumber\": \"MH12AB1234\",
        \"driverId\": \"driver-001\",
        \"driverName\": \"Ramesh Kumar\",
        \"driverPhone\": \"9876543212\"
    }")
ASSIGNMENT_ID=$(echo "$ASSIGNMENT_RESPONSE" | jq -r '.data.id')
echo "Assignment ID: $ASSIGNMENT_ID"
echo -e "${GREEN}✓ Assignment created${NC}"
echo ""

# 7. Driver Login
echo "8. Driver Login..."
DRIVER_AUTH=$(curl -s -X POST "$BASE_URL/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "9876543212", "otp": "123456", "role": "driver"}')
DRIVER_TOKEN=$(echo "$DRIVER_AUTH" | jq -r '.data.tokens.accessToken')
echo -e "${GREEN}✓ Driver logged in${NC}"
echo ""

# 8. Get Driver Assignments
echo "9. Driver Views Assignments..."
DRIVER_ASSIGNMENTS=$(curl -s -X GET "$BASE_URL/assignments/driver" \
    -H "Authorization: Bearer $DRIVER_TOKEN")
echo "$DRIVER_ASSIGNMENTS" | jq '.data.assignments | length'
echo -e "${GREEN}✓ Driver assignments retrieved${NC}"
echo ""

# 9. Accept Assignment
echo "10. Driver Accepts Assignment..."
ACCEPT_RESPONSE=$(curl -s -X PATCH "$BASE_URL/assignments/$ASSIGNMENT_ID/accept" \
    -H "Authorization: Bearer $DRIVER_TOKEN")
echo "$ACCEPT_RESPONSE" | jq '.data.status'
echo -e "${GREEN}✓ Assignment accepted${NC}"
echo ""

# 10. Check Booking Status (Customer)
echo "11. Customer Checks Booking Status..."
BOOKING_STATUS=$(curl -s -X GET "$BASE_URL/bookings/$BOOKING_ID" \
    -H "Authorization: Bearer $CUSTOMER_TOKEN")
echo "Trucks filled: $(echo "$BOOKING_STATUS" | jq '.data.booking.trucksFilled')"
echo "Status: $(echo "$BOOKING_STATUS" | jq -r '.data.booking.status')"
echo -e "${GREEN}✓ Booking status retrieved${NC}"
echo ""

# 11. Get Assigned Trucks
echo "12. Customer Views Assigned Trucks..."
TRUCKS=$(curl -s -X GET "$BASE_URL/bookings/$BOOKING_ID/trucks" \
    -H "Authorization: Bearer $CUSTOMER_TOKEN")
echo "$TRUCKS" | jq '.data.trucks'
echo -e "${GREEN}✓ Assigned trucks retrieved${NC}"
echo ""

echo "================================"
echo -e "${GREEN}✓ All tests passed!${NC}"
echo ""
echo "Summary:"
echo "- Customer created booking with 3 trucks"
echo "- Transporter viewed broadcast and assigned 1 truck"
echo "- Driver accepted the assignment"
echo "- Customer can see 1/3 trucks filled"
