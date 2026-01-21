#!/bin/bash

# =============================================================================
# WEELO LOGISTICS - COMPREHENSIVE API TEST SCRIPT
# =============================================================================
# 
# This script tests all API endpoints for both Customer and Captain apps.
# 
# USAGE:
#   chmod +x test-all-apis.sh
#   ./test-all-apis.sh
#
# PREREQUISITES:
#   - Backend server running on localhost:3000
#   - curl installed
#   - jq installed (optional, for pretty JSON output)
#
# MOCK MODE:
#   - OTP: 123456 (works for any phone in development)
#
# =============================================================================

BASE_URL="http://localhost:3000/api/v1"
HEALTH_URL="http://localhost:3000/health"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Test counters
PASSED=0
FAILED=0

# Function to print section header
print_header() {
    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  $1${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
}

# Function to print test result
print_result() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓ PASS${NC}: $2"
        ((PASSED++))
    else
        echo -e "${RED}✗ FAIL${NC}: $2"
        ((FAILED++))
    fi
}

# Function to pretty print JSON (uses jq if available, otherwise python)
pretty_json() {
    if command -v jq &> /dev/null; then
        jq '.'
    else
        python3 -m json.tool 2>/dev/null || cat
    fi
}

# =============================================================================
# HEALTH CHECK
# =============================================================================
print_header "HEALTH CHECK"

echo -e "${YELLOW}Testing: GET /health${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" $HEALTH_URL)
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    print_result 0 "Health endpoint"
    echo "$BODY" | pretty_json
else
    print_result 1 "Health endpoint (HTTP $HTTP_CODE)"
fi

# =============================================================================
# AUTHENTICATION APIs
# =============================================================================
print_header "AUTHENTICATION APIs"

# Test 1: Send OTP
echo -e "\n${YELLOW}Testing: POST /auth/send-otp${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/auth/send-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "9876543210", "role": "driver"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    print_result 0 "Send OTP"
    echo "$BODY" | pretty_json
else
    print_result 1 "Send OTP (HTTP $HTTP_CODE)"
    echo "$BODY"
fi

# Test 2: Verify OTP (Driver)
echo -e "\n${YELLOW}Testing: POST /auth/verify-otp (Driver)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "9876543210", "otp": "123456", "role": "driver"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    print_result 0 "Verify OTP (Driver)"
    DRIVER_TOKEN=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['tokens']['accessToken'])" 2>/dev/null)
    DRIVER_ID=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['user']['id'])" 2>/dev/null)
    echo "  Token: ${DRIVER_TOKEN:0:50}..."
    echo "  User ID: $DRIVER_ID"
else
    print_result 1 "Verify OTP (Driver) (HTTP $HTTP_CODE)"
    echo "$BODY"
fi

# Test 3: Verify OTP (Transporter)
echo -e "\n${YELLOW}Testing: POST /auth/verify-otp (Transporter)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "9876543211", "otp": "123456", "role": "transporter"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    print_result 0 "Verify OTP (Transporter)"
    TRANSPORTER_TOKEN=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['tokens']['accessToken'])" 2>/dev/null)
    TRANSPORTER_ID=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['user']['id'])" 2>/dev/null)
    echo "  Token: ${TRANSPORTER_TOKEN:0:50}..."
    echo "  User ID: $TRANSPORTER_ID"
else
    print_result 1 "Verify OTP (Transporter) (HTTP $HTTP_CODE)"
fi

# Test 4: Verify OTP (Customer - for Weelo app)
echo -e "\n${YELLOW}Testing: POST /auth/verify-otp (Customer)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "9876543212", "otp": "123456", "role": "customer"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    print_result 0 "Verify OTP (Customer)"
    CUSTOMER_TOKEN=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['tokens']['accessToken'])" 2>/dev/null)
    CUSTOMER_ID=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['user']['id'])" 2>/dev/null)
    echo "  Token: ${CUSTOMER_TOKEN:0:50}..."
    echo "  User ID: $CUSTOMER_ID"
else
    print_result 1 "Verify OTP (Customer) (HTTP $HTTP_CODE)"
fi

# =============================================================================
# VEHICLE APIs (Public)
# =============================================================================
print_header "VEHICLE APIs (Public)"

# Test: Get Vehicle Types
echo -e "\n${YELLOW}Testing: GET /vehicles/types${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/vehicles/types")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    print_result 0 "Get Vehicle Types"
    VEHICLE_COUNT=$(echo "$BODY" | python3 -c "import sys, json; print(len(json.load(sys.stdin)['data']['types']))" 2>/dev/null)
    echo "  Found $VEHICLE_COUNT vehicle types"
else
    print_result 1 "Get Vehicle Types (HTTP $HTTP_CODE)"
fi

# =============================================================================
# PRICING APIs
# =============================================================================
print_header "PRICING APIs"

# Test: Calculate Pricing
echo -e "\n${YELLOW}Testing: GET /pricing/estimate${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/pricing/estimate?vehicleType=open&distanceKm=100&trucksNeeded=2")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    print_result 0 "Calculate Pricing"
    echo "$BODY" | pretty_json
else
    print_result 1 "Calculate Pricing (HTTP $HTTP_CODE)"
fi

# Test different vehicle types
for VEHICLE_TYPE in "open" "container" "tanker" "tipper" "trailer"; do
    echo -e "\n${YELLOW}Testing: Pricing for $VEHICLE_TYPE${NC}"
    RESPONSE=$(curl -s "$BASE_URL/pricing/estimate?vehicleType=$VEHICLE_TYPE&distanceKm=50&trucksNeeded=1")
    PRICE=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['pricing']['totalAmount'])" 2>/dev/null)
    if [ -n "$PRICE" ]; then
        print_result 0 "$VEHICLE_TYPE pricing: ₹$PRICE"
    else
        print_result 1 "$VEHICLE_TYPE pricing"
    fi
done

# =============================================================================
# BOOKING APIs (Customer App)
# =============================================================================
print_header "BOOKING APIs (Customer App)"

if [ -n "$CUSTOMER_TOKEN" ]; then
    # Test: Create Booking
    echo -e "\n${YELLOW}Testing: POST /bookings (Create Booking)${NC}"
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/bookings" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $CUSTOMER_TOKEN" \
        -d '{
            "pickup": {
                "coordinates": {"latitude": 28.6139, "longitude": 77.2090},
                "address": "New Delhi, India"
            },
            "drop": {
                "coordinates": {"latitude": 19.0760, "longitude": 72.8777},
                "address": "Mumbai, India"
            },
            "vehicleType": "open",
            "vehicleSubtype": "14 Feet",
            "trucksNeeded": 2,
            "distanceKm": 1400,
            "pricePerTruck": 45000
        }')
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
        print_result 0 "Create Booking"
        BOOKING_ID=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['booking']['id'])" 2>/dev/null)
        echo "  Booking ID: $BOOKING_ID"
    else
        print_result 1 "Create Booking (HTTP $HTTP_CODE)"
        echo "$BODY" | pretty_json
    fi

    # Test: Get My Bookings
    echo -e "\n${YELLOW}Testing: GET /bookings (My Bookings)${NC}"
    RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/bookings" \
        -H "Authorization: Bearer $CUSTOMER_TOKEN")
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    if [ "$HTTP_CODE" = "200" ]; then
        print_result 0 "Get My Bookings"
        BOOKING_COUNT=$(echo "$BODY" | python3 -c "import sys, json; print(len(json.load(sys.stdin)['data']['bookings']))" 2>/dev/null)
        echo "  Found $BOOKING_COUNT bookings"
    else
        print_result 1 "Get My Bookings (HTTP $HTTP_CODE)"
    fi
else
    echo -e "${YELLOW}Skipping booking tests - no customer token${NC}"
fi

# =============================================================================
# BROADCAST APIs (Captain App - Transporter)
# =============================================================================
print_header "BROADCAST APIs (Captain App)"

if [ -n "$TRANSPORTER_TOKEN" ]; then
    # Test: Get Active Broadcasts
    echo -e "\n${YELLOW}Testing: GET /broadcasts/active${NC}"
    RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/broadcasts/active?driverId=$TRANSPORTER_ID" \
        -H "Authorization: Bearer $TRANSPORTER_TOKEN")
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    if [ "$HTTP_CODE" = "200" ]; then
        print_result 0 "Get Active Broadcasts"
    else
        print_result 1 "Get Active Broadcasts (HTTP $HTTP_CODE)"
    fi
else
    echo -e "${YELLOW}Skipping broadcast tests - no transporter token${NC}"
fi

# =============================================================================
# DRIVER APIs (Captain App - Driver)
# =============================================================================
print_header "DRIVER APIs (Captain App)"

if [ -n "$DRIVER_TOKEN" ]; then
    # Test: Get Driver Dashboard
    echo -e "\n${YELLOW}Testing: GET /driver/dashboard${NC}"
    RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/driver/dashboard?driverId=$DRIVER_ID" \
        -H "Authorization: Bearer $DRIVER_TOKEN")
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    if [ "$HTTP_CODE" = "200" ]; then
        print_result 0 "Get Driver Dashboard"
    else
        print_result 1 "Get Driver Dashboard (HTTP $HTTP_CODE)"
    fi

    # Test: Update Availability
    echo -e "\n${YELLOW}Testing: PUT /driver/availability${NC}"
    RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT "$BASE_URL/driver/availability" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $DRIVER_TOKEN" \
        -d '{"driverId": "'$DRIVER_ID'", "isAvailable": true}')
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    if [ "$HTTP_CODE" = "200" ]; then
        print_result 0 "Update Driver Availability"
    else
        print_result 1 "Update Driver Availability (HTTP $HTTP_CODE)"
    fi
else
    echo -e "${YELLOW}Skipping driver tests - no driver token${NC}"
fi

# =============================================================================
# PROFILE APIs
# =============================================================================
print_header "PROFILE APIs"

if [ -n "$CUSTOMER_TOKEN" ]; then
    # Test: Get Profile
    echo -e "\n${YELLOW}Testing: GET /profile${NC}"
    RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/profile" \
        -H "Authorization: Bearer $CUSTOMER_TOKEN")
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    if [ "$HTTP_CODE" = "200" ]; then
        print_result 0 "Get Profile"
    else
        print_result 1 "Get Profile (HTTP $HTTP_CODE)"
    fi

    # Test: Update Profile
    echo -e "\n${YELLOW}Testing: PUT /profile${NC}"
    RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT "$BASE_URL/profile" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $CUSTOMER_TOKEN" \
        -d '{"name": "Test User", "email": "test@weelo.in"}')
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    if [ "$HTTP_CODE" = "200" ]; then
        print_result 0 "Update Profile"
    else
        print_result 1 "Update Profile (HTTP $HTTP_CODE)"
    fi
fi

# =============================================================================
# ERROR HANDLING TESTS
# =============================================================================
print_header "ERROR HANDLING TESTS"

# Test: Invalid OTP
echo -e "\n${YELLOW}Testing: Invalid OTP${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "9876543210", "otp": "000000", "role": "driver"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "401" ]; then
    print_result 0 "Invalid OTP returns error"
else
    print_result 1 "Invalid OTP handling (HTTP $HTTP_CODE)"
fi

# Test: Missing Auth Token
echo -e "\n${YELLOW}Testing: Missing Auth Token${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/bookings")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [ "$HTTP_CODE" = "401" ]; then
    print_result 0 "Missing token returns 401"
else
    print_result 1 "Missing token handling (HTTP $HTTP_CODE)"
fi

# Test: Invalid Route
echo -e "\n${YELLOW}Testing: Invalid Route${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/invalid/route")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [ "$HTTP_CODE" = "404" ]; then
    print_result 0 "Invalid route returns 404"
else
    print_result 1 "Invalid route handling (HTTP $HTTP_CODE)"
fi

# =============================================================================
# SUMMARY
# =============================================================================
print_header "TEST SUMMARY"

TOTAL=$((PASSED + FAILED))
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo -e "Total:  $TOTAL"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 All tests passed!${NC}"
    exit 0
else
    echo -e "${YELLOW}⚠️  Some tests failed. Check the output above.${NC}"
    exit 1
fi
