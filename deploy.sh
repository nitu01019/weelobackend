#!/bin/bash
# =============================================================================
# WEELO BACKEND - QUICK DEPLOYMENT SCRIPT
# =============================================================================
# This script helps you deploy the Weelo backend to production
# =============================================================================

set -e

echo "🚀 WEELO BACKEND - DEPLOYMENT SCRIPT"
echo "===================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if .env.production exists
if [ ! -f .env.production ]; then
    echo -e "${RED}❌ Error: .env.production file not found!${NC}"
    echo ""
    echo "Please create .env.production with your production credentials:"
    echo "  cp .env .env.production"
    echo "  nano .env.production"
    echo ""
    echo "See AWS_S3_SETUP_AND_DEPLOYMENT.md for details."
    exit 1
fi

# Check if AWS credentials are set
if ! grep -q "AWS_ACCESS_KEY_ID=.\+" .env.production; then
    echo -e "${YELLOW}⚠️  Warning: AWS_ACCESS_KEY_ID not set in .env.production${NC}"
    echo "S3 uploads will use local storage fallback."
    echo ""
fi

echo "📦 Step 1: Building Docker image..."
docker build -t weelo-backend:latest . || {
    echo -e "${RED}❌ Docker build failed!${NC}"
    exit 1
}
echo -e "${GREEN}✅ Docker image built successfully${NC}"
echo ""

echo "🧪 Step 2: Testing Docker image locally..."
echo "Starting test container..."

# Stop any existing test container
docker stop weelo-backend-test 2>/dev/null || true
docker rm weelo-backend-test 2>/dev/null || true

# Run test container
docker run -d \
    --name weelo-backend-test \
    -p 3001:3000 \
    --env-file .env.production \
    weelo-backend:latest

echo "Waiting for container to start..."
sleep 5

# Check health
if curl -f http://localhost:3001/health &>/dev/null; then
    echo -e "${GREEN}✅ Health check passed!${NC}"
else
    echo -e "${RED}❌ Health check failed!${NC}"
    echo "Container logs:"
    docker logs weelo-backend-test
    docker stop weelo-backend-test
    docker rm weelo-backend-test
    exit 1
fi

# Stop test container
docker stop weelo-backend-test &>/dev/null
docker rm weelo-backend-test &>/dev/null

echo -e "${GREEN}✅ Docker image tested successfully${NC}"
echo ""

echo "🎯 Step 3: Choose deployment method:"
echo "  1) AWS EC2 (Manual deployment to EC2 instance)"
echo "  2) AWS ECS (Push to ECR, manual ECS setup)"
echo "  3) AWS Elastic Beanstalk (Automated deployment)"
echo "  4) Skip (just build image)"
echo ""
read -p "Enter choice [1-4]: " choice

case $choice in
    1)
        echo ""
        echo "📝 AWS EC2 Deployment Instructions:"
        echo "=================================="
        echo ""
        echo "1. SSH into your EC2 instance:"
        echo "   ssh -i your-key.pem ubuntu@your-ec2-ip"
        echo ""
        echo "2. Install Docker on EC2 (if not already installed):"
        echo "   sudo apt update && sudo apt install -y docker.io docker-compose"
        echo ""
        echo "3. Copy files to EC2:"
        echo "   scp -i your-key.pem -r . ubuntu@your-ec2-ip:/home/ubuntu/weelo-backend"
        echo ""
        echo "4. On EC2, build and run:"
        echo "   cd /home/ubuntu/weelo-backend"
        echo "   docker build -t weelo-backend:latest ."
        echo "   docker run -d --name weelo-backend -p 3000:3000 --env-file .env.production weelo-backend:latest"
        echo ""
        ;;
    2)
        echo ""
        read -p "Enter your AWS Account ID: " aws_account_id
        read -p "Enter AWS Region [ap-south-1]: " aws_region
        aws_region=${aws_region:-ap-south-1}
        
        ECR_URI="${aws_account_id}.dkr.ecr.${aws_region}.amazonaws.com/weelo-backend"
        
        echo ""
        echo "🔐 Logging into AWS ECR..."
        aws ecr get-login-password --region ${aws_region} | docker login --username AWS --password-stdin ${aws_account_id}.dkr.ecr.${aws_region}.amazonaws.com || {
            echo -e "${RED}❌ ECR login failed! Make sure AWS CLI is configured.${NC}"
            exit 1
        }
        
        echo "🏷️  Tagging image..."
        docker tag weelo-backend:latest ${ECR_URI}:latest
        
        echo "📤 Pushing to ECR..."
        docker push ${ECR_URI}:latest
        
        echo -e "${GREEN}✅ Image pushed to ECR!${NC}"
        echo ""
        echo "Next steps:"
        echo "1. Go to AWS ECS Console"
        echo "2. Create/Update Task Definition with image: ${ECR_URI}:latest"
        echo "3. Update ECS Service to use new task definition"
        echo ""
        echo "See AWS_S3_SETUP_AND_DEPLOYMENT.md for detailed instructions."
        ;;
    3)
        echo ""
        echo "🌱 Deploying to Elastic Beanstalk..."
        
        if ! command -v eb &> /dev/null; then
            echo -e "${RED}❌ EB CLI not installed!${NC}"
            echo "Install with: pip install awsebcli"
            exit 1
        fi
        
        eb deploy || {
            echo -e "${RED}❌ EB deploy failed!${NC}"
            echo "Initialize EB first with: eb init -p docker -r ap-south-1 weelo-backend"
            exit 1
        }
        
        echo -e "${GREEN}✅ Deployed to Elastic Beanstalk!${NC}"
        eb open
        ;;
    4)
        echo ""
        echo -e "${GREEN}✅ Docker image ready for deployment!${NC}"
        echo "Image: weelo-backend:latest"
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

echo ""
echo "=========================================="
echo -e "${GREEN}🎉 Deployment process complete!${NC}"
echo "=========================================="
echo ""
echo "📚 For detailed instructions, see:"
echo "   AWS_S3_SETUP_AND_DEPLOYMENT.md"
echo ""
echo "🧪 Test your deployment:"
echo "   curl https://your-domain/health"
echo ""
