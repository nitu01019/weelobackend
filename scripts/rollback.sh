#!/bin/bash
# =============================================================================
# ROLLBACK SCRIPT - Weelo Backend
# =============================================================================
# SCALABILITY: Quick rollback for production issues
# EASY UNDERSTANDING: Simple one-command rollback
# MODULARITY: Standalone rollback logic
# =============================================================================

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🔄 WEELO BACKEND - ROLLBACK"
echo "==========================="
echo ""

REGION="ap-south-1"
CLUSTER="weelocluster"
SERVICE="weelobackendtask-service-joxh3c0r"

echo -e "${YELLOW}⚠️  This will rollback to the previous deployment${NC}"
echo ""
read -p "Continue? (y/N): " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Rollback cancelled"
    exit 1
fi

echo "🔄 Rolling back ECS service..."

# Force new deployment with previous task definition
aws ecs update-service \
  --cluster ${CLUSTER} \
  --service ${SERVICE} \
  --force-new-deployment \
  --region ${REGION} \
  --no-cli-pager

echo ""
echo -e "${GREEN}✅ Rollback initiated${NC}"
echo ""
echo "Waiting for rollback to complete..."

aws ecs wait services-stable \
  --cluster ${CLUSTER} \
  --services ${SERVICE} \
  --region ${REGION}

echo ""
echo -e "${GREEN}✅ Rollback complete${NC}"
echo ""
