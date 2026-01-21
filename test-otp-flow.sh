#!/bin/bash
# =============================================================================
# OTP FLOW TEST SCRIPT
# =============================================================================
# Run this script to verify OTP authentication is working correctly
# Usage: ./test-otp-flow.sh
# =============================================================================

BASE_URL="http://localhost:3000/api/v1"
PHONE="9876543210"
ROLE="transporter"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              OTP FLOW VERIFICATION TEST                      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Test 1: Send OTP
echo "📱 Test 1: Sending OTP to $PHONE..."
SEND_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/send-otp" \
  -H "Content-Type: application/json" \
  -d "{\"phone\": \"$PHONE\", \"role\": \"$ROLE\"}")

echo "Response: $SEND_RESPONSE"
echo ""

# Check if send was successful
if echo "$SEND_RESPONSE" | grep -q '"success":true'; then
  echo "✅ Test 1 PASSED: OTP sent successfully"
else
  echo "❌ Test 1 FAILED: Could not send OTP"
  exit 1
fi
echo ""

# Extract message
MESSAGE=$(echo "$SEND_RESPONSE" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
echo "📝 Message: $MESSAGE"
echo ""

# Test 2: Verify OTP with wrong code (should fail)
echo "🔐 Test 2: Verifying with WRONG OTP (should fail)..."
WRONG_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/verify-otp" \
  -H "Content-Type: application/json" \
  -d "{\"phone\": \"$PHONE\", \"otp\": \"000000\", \"role\": \"$ROLE\"}")

if echo "$WRONG_RESPONSE" | grep -q '"success":false'; then
  echo "✅ Test 2 PASSED: Wrong OTP correctly rejected"
else
  echo "❌ Test 2 FAILED: Wrong OTP should have been rejected"
  exit 1
fi
echo ""

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              ALL OTP TESTS PASSED ✅                         ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "📋 To complete full verification:"
echo "   1. Check the backend console for the generated OTP"
echo "   2. Use that OTP to verify: "
echo "      curl -X POST $BASE_URL/auth/verify-otp \\"
echo "        -H 'Content-Type: application/json' \\"
echo "        -d '{\"phone\": \"$PHONE\", \"otp\": \"YOUR_OTP\", \"role\": \"$ROLE\"}'"
echo ""
