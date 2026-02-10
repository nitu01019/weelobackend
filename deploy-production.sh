#!/bin/bash
# =============================================================================
# PRODUCTION DEPLOYMENT SCRIPT - Weelo Backend (NO TESTING)
# =============================================================================
# SCALABILITY: Direct to production deployment
# EASY UNDERSTANDING: Clear step-by-step flow
# MODULARITY: Calls separate build scripts
# SAME STANDARDS: Follow existing deployment patterns
# =============================================================================

set -e  # Exit on error

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "🚀 WEELO BACKEND - PRODUCTION DEPLOYMENT"
echo "========================================="
echo ""
echo -e "${YELLOW}⚠️  WARNING: This will deploy directly to PRODUCTION${NC}"
echo ""

# =============================================================================
# Configuration
# =============================================================================
ECR_REPO="318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend"
REGION="ap-south-1"
CLUSTER="weelocluster"
SERVICE="weelobackendtask-service-joxh3c0r"

# Generate version tag
VERSION=$(date +%Y%m%d-%H%M%S)
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "local")
FULL_VERSION="${VERSION}-${GIT_COMMIT}"

echo -e "${BLUE}📦 Version: ${FULL_VERSION}${NC}"
echo ""

# =============================================================================
# STEP 1: Validate Environment
# =============================================================================
echo "📋 Step 1: Validating environment..."

if [ ! -f ".env.production" ]; then
    echo -e "${RED}❌ Error: .env.production file not found!${NC}"
    exit 1
fi

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ Error: AWS CLI not installed!${NC}"
    exit 1
fi

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Error: Docker not installed!${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Environment validated${NC}"
echo ""

# =============================================================================
# STEP 2: Build Production Code
# =============================================================================
echo "🏗️  Step 2: Building production code..."

./scripts/build-production.sh

echo -e "${GREEN}✅ Production build complete${NC}"
echo ""

# =============================================================================
# STEP 3: Build Docker Image (Production)
# =============================================================================
echo "🐳 Step 3: Building Docker image for linux/amd64..."

# MODULARITY: Read environment variables from .env file
echo "📝 Loading environment variables from .env..."
if [ -f ".env" ]; then
  GOOGLE_MAPS_API_KEY=$(grep "^GOOGLE_MAPS_API_KEY=" .env | cut -d '=' -f2)
  echo "✅ Loaded GOOGLE_MAPS_API_KEY"
else
  echo -e "${YELLOW}⚠️  Warning: .env file not found, using .env.production${NC}"
  GOOGLE_MAPS_API_KEY=$(grep "^GOOGLE_MAPS_API_KEY=" .env.production | cut -d '=' -f2)
fi

# SCALABILITY: Use BuildKit for faster multi-platform builds
# PLATFORM: Explicitly build for AMD64 to match ECS architecture
export DOCKER_BUILDKIT=1
docker build -f Dockerfile.production \
  --platform linux/amd64 \
  --build-arg GOOGLE_MAPS_API_KEY="${GOOGLE_MAPS_API_KEY}" \
  -t weelo-backend:latest \
  -t weelo-backend:${FULL_VERSION} \
  .

echo -e "${GREEN}✅ Docker image built${NC}"
echo ""

# =============================================================================
# STEP 4: Login to AWS ECR
# =============================================================================
echo "🔐 Step 4: Logging into AWS ECR..."

aws ecr get-login-password --region ${REGION} | \
  docker login --username AWS --password-stdin ${ECR_REPO}

echo -e "${GREEN}✅ Logged into ECR${NC}"
echo ""

# =============================================================================
# STEP 5: Tag and Push to ECR
# =============================================================================
echo "📤 Step 5: Pushing to ECR..."

docker tag weelo-backend:latest ${ECR_REPO}:latest
docker tag weelo-backend:latest ${ECR_REPO}:${FULL_VERSION}

docker push ${ECR_REPO}:${FULL_VERSION}
docker push ${ECR_REPO}:latest

echo -e "${GREEN}✅ Images pushed to ECR${NC}"
echo ""

# =============================================================================
# STEP 6: Update ECS Service
# =============================================================================
echo "☁️  Step 6: Deploying to ECS..."

aws ecs update-service \
  --cluster ${CLUSTER} \
  --service ${SERVICE} \
  --force-new-deployment \
  --region ${REGION} \
  --no-cli-pager

echo -e "${GREEN}✅ ECS service updated${NC}"
echo ""

# =============================================================================
# STEP 7: Wait for Deployment
# =============================================================================
echo "⏳ Step 7: Waiting for deployment to complete..."
echo "   (This may take 2-3 minutes)"
echo ""

aws ecs wait services-stable \
  --cluster ${CLUSTER} \
  --services ${SERVICE} \
  --region ${REGION}

echo -e "${GREEN}✅ Deployment complete${NC}"
echo ""

# =============================================================================
# SUCCESS
# =============================================================================
echo "==========================================="
echo -e "${GREEN}🎉 PRODUCTION DEPLOYMENT SUCCESSFUL!${NC}"
echo "==========================================="
echo ""
echo "Deployment details:"
echo "  📦 Version: ${FULL_VERSION}"
echo "  🐳 Image: ${ECR_REPO}:${FULL_VERSION}"
echo "  ☁️  Cluster: ${CLUSTER}"
echo "  🔧 Service: ${SERVICE}"
echo ""
echo "Health check:"
echo "  curl http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/health"
echo ""
echo "To rollback:"
echo "  ./scripts/rollback.sh"
echo ""
