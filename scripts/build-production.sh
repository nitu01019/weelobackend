#!/bin/bash
# =============================================================================
# PRODUCTION BUILD SCRIPT - Weelo Backend
# =============================================================================
# SCALABILITY: Optimized build process for production
# EASY UNDERSTANDING: Clear steps with error handling
# MODULARITY: Separate build concerns
# SAME STANDARDS: Follow existing bash patterns
# =============================================================================

set -e  # Exit on error

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🏗️  WEELO BACKEND - PRODUCTION BUILD"
echo "====================================="
echo ""

# =============================================================================
# STEP 1: Validate Environment
# =============================================================================
echo "📋 Step 1: Validating environment..."

if [ ! -f ".env.production" ]; then
    echo -e "${RED}❌ Error: .env.production file not found!${NC}"
    exit 1
fi

if [ ! -f "package.json" ]; then
    echo -e "${RED}❌ Error: package.json not found!${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Environment validated${NC}"
echo ""

# =============================================================================
# STEP 2: Clean Previous Build
# =============================================================================
echo "🧹 Step 2: Cleaning previous build..."

rm -rf dist
rm -rf node_modules/.cache 2>/dev/null || true

echo -e "${GREEN}✅ Cleaned dist/ and cache${NC}"
echo ""

# =============================================================================
# STEP 3: Install All Dependencies (including dev for build)
# =============================================================================
echo "📦 Step 3: Installing all dependencies (including dev for build)..."

npm ci --legacy-peer-deps --loglevel=error

echo -e "${GREEN}✅ Dependencies installed${NC}"
echo ""

# =============================================================================
# STEP 4: Generate Prisma Client
# =============================================================================
echo "🗄️  Step 4: Generating Prisma client..."

npx prisma generate

echo -e "${GREEN}✅ Prisma client generated${NC}"
echo ""

# =============================================================================
# STEP 5: Apply Database Migrations (Production)
# =============================================================================
echo "🔄 Step 5: Applying database migrations..."

# Load production environment variables for DATABASE_URL
if [ -f ".env.production" ]; then
    export $(cat .env.production | grep -v '^#' | xargs)
fi

# Run migration deploy - idempotent, only runs new migrations
npx prisma migrate deploy

echo -e "${GREEN}✅ Database migrations applied${NC}"
echo ""

# =============================================================================
# STEP 6: Build TypeScript
# =============================================================================
echo "⚡ Step 6: Building TypeScript..."

npm run build

echo -e "${GREEN}✅ TypeScript compiled${NC}"
echo ""

# =============================================================================
# STEP 7: Verify Build
# =============================================================================
echo "✓ Step 7: Verifying build..."

if [ ! -f "dist/server.js" ]; then
    echo -e "${RED}❌ Build failed - dist/server.js not found${NC}"
    exit 1
fi

if [ ! -f "dist/cluster.js" ]; then
    echo -e "${RED}❌ Build failed - dist/cluster.js not found${NC}"
    exit 1
fi

# Check dist size
DIST_SIZE=$(du -sh dist | cut -f1)
echo "   📦 Build size: $DIST_SIZE"

echo -e "${GREEN}✅ Build verified${NC}"
echo ""

# =============================================================================
# SUCCESS
# =============================================================================
echo "==========================================="
echo -e "${GREEN}✅ PRODUCTION BUILD COMPLETE!${NC}"
echo "==========================================="
echo ""
echo "Build artifacts:"
echo "  📁 dist/server.js"
echo "  📁 dist/cluster.js"
echo "  📁 node_modules/.prisma/client"
echo ""
echo "Next steps:"
echo "  1. docker build -f Dockerfile.production -t weelo-backend:latest ."
echo "  2. ./scripts/deploy-to-ecs.sh"
echo ""
