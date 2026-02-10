#!/bin/bash
# Backend Optimization Script

echo "🚀 Optimizing Weelo Backend for Production..."

# Step 1: Apply database indexes
echo "📊 Adding database indexes..."
npx prisma db execute --file prisma/migrations/add_indexes.sql --schema prisma/schema.prisma

# Step 2: Build optimized code
echo "🔨 Building optimized code..."
npm run build

# Step 3: Docker build with optimizations
echo "🐳 Building optimized Docker image..."
docker buildx build \
  --platform linux/amd64 \
  -f Dockerfile.production \
  --push \
  -t 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:v1.0.9-optimized \
  .

echo "✅ Backend optimization complete!"
