#!/bin/bash

# =============================================================================
# WEELO UNIFIED BACKEND - QUICK START SCRIPT
# =============================================================================
# Run this script to start the backend server
# Usage: ./start.sh [dev|prod]
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║           🚛 WEELO UNIFIED BACKEND STARTER                    ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if .env exists
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}⚠️  No .env file found. Creating from .env.example...${NC}"
    cp .env.example .env
    echo -e "${GREEN}✅ Created .env file${NC}"
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}📦 Installing dependencies...${NC}"
    npm install
    echo -e "${GREEN}✅ Dependencies installed${NC}"
fi

# Get mode from argument or default to dev
MODE=${1:-dev}

if [ "$MODE" == "prod" ]; then
    echo -e "${BLUE}🏭 Starting in PRODUCTION mode...${NC}"
    echo ""
    npm run build
    npm start
else
    echo -e "${BLUE}🔧 Starting in DEVELOPMENT mode...${NC}"
    echo ""
    echo -e "${YELLOW}📱 Connect your apps:${NC}"
    echo -e "   • Android Emulator: ${GREEN}http://10.0.2.2:3000${NC}"
    
    # Try to get local IP
    LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | head -1 | awk '{print $2}')
    if [ ! -z "$LOCAL_IP" ]; then
        echo -e "   • Physical Device:  ${GREEN}http://$LOCAL_IP:3000${NC}"
    fi
    echo ""
    echo -e "${YELLOW}🔑 Mock OTP: ${GREEN}123456${NC} (for any phone number)"
    echo ""
    
    npm run dev
fi
