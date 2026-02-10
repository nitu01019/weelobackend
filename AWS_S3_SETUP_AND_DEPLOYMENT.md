# 🚀 WEELO BACKEND - AWS S3 Setup & Complete Deployment Guide

## 📋 Table of Contents

1. [AWS S3 Configuration](#aws-s3-configuration)
2. [Environment Variables Setup](#environment-variables-setup)
3. [Docker Build & Test](#docker-build--test)
4. [AWS Deployment Options](#aws-deployment-options)
5. [Production Checklist](#production-checklist)

---

## 🪣 AWS S3 Configuration

### Step 1: Create S3 Bucket for Driver Photos

```bash
# Login to AWS Console
# Go to S3 → Create bucket

# Or use AWS CLI:
aws s3 mb s3://weelo-driver-profiles-production --region ap-south-1
```

**Bucket Configuration:**
- **Name**: `weelo-driver-profiles-production`
- **Region**: `ap-south-1` (Mumbai) - Choose closest to your users
- **Block Public Access**: Keep enabled (we'll use presigned URLs)
- **Versioning**: Enabled (recommended for backups)
- **Encryption**: AES-256 (enabled by default)

### Step 2: Create IAM User for Backend

```bash
# Go to IAM → Users → Create User
# Name: weelo-backend-s3-user
# Access: Programmatic access
```

**Permissions Policy** (Attach inline policy):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WeeloS3Access",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::weelo-driver-profiles-production",
        "arn:aws:s3:::weelo-driver-profiles-production/*"
      ]
    }
  ]
}
```

**Save these credentials securely:**
- Access Key ID: `AKIAIOSFODNN7EXAMPLE`
- Secret Access Key: `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`

### Step 3: Configure S3 CORS (For Direct Browser Uploads - Optional)

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE"],
    "AllowedOrigins": ["https://app.weelo.in", "https://www.weelo.in"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

### Step 4: Set Lifecycle Rules (Optional - Cost Optimization)

```
# Archive old photos after 90 days to S3 Glacier
Rule: Archive old driver photos
Status: Enabled
Scope: driver-photos/ prefix
Transition: 90 days → Glacier
Expiration: Never (or 365 days for deleted drivers)
```

---

## 🔐 Environment Variables Setup

### Create Production Environment File

```bash
cd /Users/nitishbhardwaj/Desktop/Weelo-backend
cp .env .env.production
nano .env.production
```

### Update `.env.production` with AWS Credentials:

```bash
# =============================================================================
# PRODUCTION ENVIRONMENT - WEELO BACKEND
# =============================================================================

# -----------------------------------------------------------------------------
# Server Configuration
# -----------------------------------------------------------------------------
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# -----------------------------------------------------------------------------
# Database (AWS RDS or Local PostgreSQL)
# -----------------------------------------------------------------------------
DB_HOST=weelo-db.xxxxx.ap-south-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=weelo_production
DB_USER=weelo_admin
DB_PASSWORD=YOUR_STRONG_DB_PASSWORD_HERE

# Or use DATABASE_URL
DATABASE_URL=postgresql://weelo_admin:YOUR_STRONG_DB_PASSWORD_HERE@weelo-db.xxxxx.ap-south-1.rds.amazonaws.com:5432/weelo_production

# -----------------------------------------------------------------------------
# Redis (AWS ElastiCache or Local Redis)
# -----------------------------------------------------------------------------
REDIS_ENABLED=true
REDIS_HOST=weelo-redis.xxxxx.cache.amazonaws.com
REDIS_PORT=6379
REDIS_PASSWORD=YOUR_REDIS_PASSWORD_HERE
REDIS_URL=redis://:YOUR_REDIS_PASSWORD_HERE@weelo-redis.xxxxx.cache.amazonaws.com:6379

# -----------------------------------------------------------------------------
# JWT Secrets (CRITICAL - Generate strong secrets!)
# -----------------------------------------------------------------------------
# Generate with: openssl rand -base64 64
JWT_SECRET=YOUR_SUPER_SECRET_JWT_KEY_64_CHARS_MINIMUM
JWT_REFRESH_SECRET=YOUR_SUPER_SECRET_REFRESH_KEY_64_CHARS_MINIMUM
JWT_EXPIRES_IN=7d

# -----------------------------------------------------------------------------
# AWS S3 Configuration (REQUIRED FOR PHOTO UPLOADS)
# -----------------------------------------------------------------------------
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_BUCKET=weelo-driver-profiles-production

# AWS SNS (For SMS OTP)
AWS_SNS_REGION=ap-south-1

# -----------------------------------------------------------------------------
# CORS Configuration
# -----------------------------------------------------------------------------
ALLOWED_ORIGINS=https://app.weelo.in,https://admin.weelo.in

# -----------------------------------------------------------------------------
# Rate Limiting
# -----------------------------------------------------------------------------
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------
LOG_LEVEL=info
```

### Generate Strong JWT Secrets:

```bash
# Generate JWT_SECRET
openssl rand -base64 64

# Generate JWT_REFRESH_SECRET (use different value!)
openssl rand -base64 64
```

---

## 🐳 Docker Build & Test

### Step 1: Build Production Docker Image

```bash
cd /Users/nitishbhardwaj/Desktop/Weelo-backend

# Build the image
docker build -t weelo-backend:latest .

# Check image size (should be < 200MB)
docker images weelo-backend:latest
```

**Expected output:**
```
REPOSITORY       TAG       IMAGE ID       CREATED         SIZE
weelo-backend    latest    abc123def456   2 minutes ago   185MB
```

### Step 2: Test Docker Image Locally

```bash
# Run container with production env
docker run -d \
  --name weelo-backend-test \
  -p 3000:3000 \
  --env-file .env.production \
  weelo-backend:latest

# Check logs
docker logs -f weelo-backend-test

# Test health endpoint
curl http://localhost:3000/health

# Expected: {"status":"ok","timestamp":"..."}
```

### Step 3: Test S3 Upload

```bash
# Test profile completion API
curl -X POST http://localhost:3000/api/v1/driver/complete-profile \
  -H "Authorization: Bearer YOUR_TEST_JWT_TOKEN" \
  -F "licenseNumber=DL1234567890" \
  -F "vehicleType=Tata Ace" \
  -F "address=Test Address" \
  -F "language=en" \
  -F "driverPhoto=@test-driver.jpg" \
  -F "licenseFront=@test-license-front.jpg" \
  -F "licenseBack=@test-license-back.jpg"

# Should return success with S3 URLs
```

### Step 4: Stop Test Container

```bash
docker stop weelo-backend-test
docker rm weelo-backend-test
```

---

## ☁️ AWS Deployment Options

### Option 1: AWS EC2 (Most Control, Manual Setup)

#### Prerequisites:
- EC2 instance (t3.medium or larger)
- Ubuntu 22.04 LTS
- Docker installed
- Security Group: Allow ports 80, 443, 3000

#### Deployment Steps:

```bash
# 1. SSH into EC2
ssh -i your-key.pem ubuntu@your-ec2-ip

# 2. Install Docker
sudo apt update
sudo apt install -y docker.io docker-compose
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ubuntu

# 3. Clone/Upload your code
# Option A: Git clone
git clone https://github.com/your-org/weelo-backend.git
cd weelo-backend

# Option B: Copy files with SCP
# (From local machine)
scp -i your-key.pem -r /Users/nitishbhardwaj/Desktop/Weelo-backend ubuntu@your-ec2-ip:/home/ubuntu/

# 4. Create production env file
nano .env.production
# (Paste your production environment variables)

# 5. Build Docker image
docker build -t weelo-backend:latest .

# 6. Run with Docker Compose
docker-compose -f docker-compose.production.yml up -d

# 7. Check logs
docker-compose logs -f backend
```

#### Create `docker-compose.production.yml`:

```yaml
version: '3.8'

services:
  backend:
    image: weelo-backend:latest
    container_name: weelo-backend-prod
    restart: always
    ports:
      - "3000:3000"
    env_file:
      - .env.production
    volumes:
      - /home/ubuntu/uploads:/app/uploads
      - /home/ubuntu/logs:/app/logs
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

#### Setup Nginx Reverse Proxy:

```bash
# Install Nginx
sudo apt install -y nginx

# Configure Nginx
sudo nano /etc/nginx/sites-available/weelo

# Paste:
server {
    listen 80;
    server_name api.weelo.in;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}

# Enable site
sudo ln -s /etc/nginx/sites-available/weelo /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

#### Setup SSL with Let's Encrypt:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.weelo.in
```

---

### Option 2: AWS ECS (Elastic Container Service) - Recommended

#### Prerequisites:
- AWS CLI installed and configured
- Docker image pushed to ECR

#### Step 1: Create ECR Repository

```bash
# Create ECR repository
aws ecr create-repository \
  --repository-name weelo-backend \
  --region ap-south-1

# Login to ECR
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin \
  YOUR_AWS_ACCOUNT_ID.dkr.ecr.ap-south-1.amazonaws.com
```

#### Step 2: Push Docker Image to ECR

```bash
# Tag image
docker tag weelo-backend:latest \
  YOUR_AWS_ACCOUNT_ID.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest

# Push image
docker push YOUR_AWS_ACCOUNT_ID.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest
```

#### Step 3: Create ECS Cluster

```bash
# Via AWS Console:
# ECS → Clusters → Create Cluster
# Name: weelo-production
# Infrastructure: AWS Fargate (serverless)
```

#### Step 4: Create Task Definition

Create file `ecs-task-definition.json`:

```json
{
  "family": "weelo-backend",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::YOUR_ACCOUNT_ID:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "weelo-backend",
      "image": "YOUR_AWS_ACCOUNT_ID.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest",
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {"name": "NODE_ENV", "value": "production"},
        {"name": "PORT", "value": "3000"},
        {"name": "AWS_REGION", "value": "ap-south-1"},
        {"name": "S3_BUCKET", "value": "weelo-driver-profiles-production"}
      ],
      "secrets": [
        {"name": "DB_PASSWORD", "valueFrom": "arn:aws:secretsmanager:..."},
        {"name": "JWT_SECRET", "valueFrom": "arn:aws:secretsmanager:..."},
        {"name": "AWS_ACCESS_KEY_ID", "valueFrom": "arn:aws:secretsmanager:..."},
        {"name": "AWS_SECRET_ACCESS_KEY", "valueFrom": "arn:aws:secretsmanager:..."}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/weelo-backend",
          "awslogs-region": "ap-south-1",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
```

Register task definition:

```bash
aws ecs register-task-definition --cli-input-json file://ecs-task-definition.json
```

#### Step 5: Create ECS Service with Load Balancer

```bash
# Via AWS Console:
# 1. Create Application Load Balancer (ALB)
#    - Name: weelo-backend-alb
#    - Scheme: Internet-facing
#    - Target group: weelo-backend-targets (port 3000)

# 2. Create ECS Service
#    - Cluster: weelo-production
#    - Task Definition: weelo-backend:1
#    - Service name: weelo-backend-service
#    - Desired tasks: 2 (for high availability)
#    - Load balancer: weelo-backend-alb
#    - Auto Scaling: Target tracking (70% CPU)
```

---

### Option 3: AWS Elastic Beanstalk (Easiest, Managed)

```bash
# Install EB CLI
pip install awsebcli

# Initialize Elastic Beanstalk
cd /Users/nitishbhardwaj/Desktop/Weelo-backend
eb init -p docker -r ap-south-1 weelo-backend

# Create environment
eb create weelo-production

# Set environment variables
eb setenv \
  NODE_ENV=production \
  AWS_REGION=ap-south-1 \
  AWS_ACCESS_KEY_ID=YOUR_KEY \
  AWS_SECRET_ACCESS_KEY=YOUR_SECRET \
  S3_BUCKET=weelo-driver-profiles-production \
  JWT_SECRET=YOUR_JWT_SECRET

# Deploy
eb deploy

# Open in browser
eb open
```

---

## ✅ Production Checklist

### Pre-Deployment:

- [ ] AWS S3 bucket created (`weelo-driver-profiles-production`)
- [ ] IAM user created with S3 permissions
- [ ] AWS credentials saved securely
- [ ] `.env.production` file created with all variables
- [ ] JWT secrets generated (strong, random)
- [ ] Database connection tested
- [ ] Redis connection tested
- [ ] Docker image built successfully
- [ ] Docker image tested locally
- [ ] S3 upload tested from Docker container

### Post-Deployment:

- [ ] Health endpoint responding (`/health`)
- [ ] API accessible via domain/IP
- [ ] SSL certificate installed (HTTPS)
- [ ] Driver profile upload tested end-to-end
- [ ] Photos appearing in S3 bucket
- [ ] Database entries created correctly
- [ ] WebSocket connections working
- [ ] Logs configured and accessible
- [ ] CloudWatch monitoring enabled (if ECS)
- [ ] Auto-scaling configured
- [ ] Backup strategy in place (database snapshots)
- [ ] Domain DNS configured (api.weelo.in → Load Balancer)

### Security:

- [ ] Environment variables stored in AWS Secrets Manager
- [ ] Security groups configured (only necessary ports open)
- [ ] S3 bucket not publicly accessible
- [ ] Rate limiting enabled
- [ ] CORS properly configured
- [ ] API keys rotated after initial setup
- [ ] IAM principle of least privilege applied

---

## 🧪 Testing Production Deployment

### 1. Health Check

```bash
curl https://api.weelo.in/health
# Expected: {"status":"ok","timestamp":"..."}
```

### 2. Test Driver Profile Upload

```bash
# Get JWT token by logging in as driver
TOKEN=$(curl -X POST https://api.weelo.in/api/v1/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone":"9876543210","otp":"123456","role":"driver"}' \
  | jq -r '.data.token')

# Upload profile with photos
curl -X POST https://api.weelo.in/api/v1/driver/complete-profile \
  -H "Authorization: Bearer $TOKEN" \
  -F "licenseNumber=DL1234567890" \
  -F "vehicleType=Tata Ace" \
  -F "address=Mumbai" \
  -F "language=en" \
  -F "driverPhoto=@driver.jpg" \
  -F "licenseFront=@license-front.jpg" \
  -F "licenseBack=@license-back.jpg"
```

### 3. Verify S3 Upload

```bash
# List objects in S3 bucket
aws s3 ls s3://weelo-driver-profiles-production/driver-photos/ --recursive

# Should show uploaded files
```

### 4. Check from Android App

1. Update API base URL in `ApiClient.kt`:
```kotlin
private const val BASE_URL = "https://api.weelo.in/api/v1/"
```

2. Rebuild and test app
3. Complete driver profile
4. Verify photos upload to S3

---

## 📊 Monitoring & Maintenance

### CloudWatch Logs (ECS)

```bash
# View logs
aws logs tail /ecs/weelo-backend --follow
```

### EC2 Logs

```bash
# SSH into EC2
ssh -i your-key.pem ubuntu@your-ec2-ip

# View Docker logs
docker logs -f weelo-backend-prod

# View application logs
tail -f /home/ubuntu/logs/app.log
```

### S3 Usage

```bash
# Check S3 storage usage
aws s3 ls s3://weelo-driver-profiles-production --recursive --summarize --human-readable
```

---

## 💰 Cost Estimation (Monthly)

### AWS Services:

| Service | Configuration | Estimated Cost |
|---------|--------------|----------------|
| ECS Fargate | 2 tasks, 512 CPU, 1GB RAM | $30-40 |
| Application Load Balancer | Standard | $20-25 |
| RDS PostgreSQL | db.t3.small | $30-40 |
| ElastiCache Redis | cache.t3.micro | $15-20 |
| S3 Storage | 100GB photos | $2-3 |
| S3 Requests | 1M requests | $0.50 |
| CloudWatch Logs | 10GB logs | $5-7 |
| Data Transfer | 100GB out | $10-15 |
| **Total** | | **$112-150/month** |

**Scalable to millions of users with:**
- ECS Auto Scaling (adds tasks as needed)
- RDS Read Replicas
- CloudFront CDN for S3 photos
- ElastiCache Redis cluster

---

## 🆘 Troubleshooting

### Issue: Docker build fails

```bash
# Clear Docker cache
docker system prune -a

# Rebuild
docker build --no-cache -t weelo-backend:latest .
```

### Issue: S3 upload fails with "Access Denied"

```bash
# Verify IAM permissions
aws s3 cp test.txt s3://weelo-driver-profiles-production/test.txt

# Check environment variables
docker exec weelo-backend-prod env | grep AWS
```

### Issue: Health check failing

```bash
# Check container logs
docker logs weelo-backend-prod

# Check database connection
docker exec weelo-backend-prod node -e "const {Pool}=require('pg');new Pool().query('SELECT 1').then(()=>console.log('OK'))"
```

---

## 🎉 Deployment Complete!

Your Weelo backend is now:
- ✅ Running in production
- ✅ Using AWS S3 for photo storage
- ✅ Scalable to millions of users
- ✅ Secure and monitored
- ✅ Highly available with auto-scaling

**Next Steps:**
1. Update Android app with production API URL
2. Test end-to-end with real devices
3. Monitor CloudWatch for errors
4. Set up automated backups
5. Configure alerts for critical errors

**Need help?** Check the logs first, then refer to the troubleshooting section above.
