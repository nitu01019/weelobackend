# WEELO BACKEND - AWS DEPLOYMENT CONTEXT

## 🎯 CURRENT STATUS (January 24, 2026)

### ✅ COMPLETED:
1. VPC created: `weelo-vpc` (vpc-08f084adaed25f590)
2. Security Groups created: `weelo-alb-sg`, `weelo-ecs-sg`, `weelo-rds-sg`, `weelo-redis-sg`
3. RDS PostgreSQL created: `weelodb` (db.t3.micro, Free tier)
4. ElastiCache Redis created: `weeloredis` (Serverless)
5. ECR Repository created: `weelo-backend`
6. Docker image pushed: `318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest`
7. ECS Cluster created: `weelocluster`
8. Task Definition created: `weelobackendtask`
9. Load Balancer created: `weelo-alb`
10. Target Group created: `weelo-tg` (port 3000)
11. ECS Service created (but failing due to missing env vars)

### ⏳ IN PROGRESS:
1. Configure Redis connection properly
2. Enable AWS SNS for real SMS
3. Update Task Definition with correct environment variables
4. Redeploy ECS Service

---

## 📁 PROJECT STRUCTURE

```
/Users/nitishbhardwaj/Desktop/weelo-backend/     - Node.js/TypeScript Backend
/Users/nitishbhardwaj/Desktop/weelo/             - Customer App (Android)
/Users/nitishbhardwaj/Desktop/weelo captain/     - Captain/Transporter App (Android)
```

---

## 🔧 AWS RESOURCES

### Account Info:
- **AWS Account ID**: 318774499084
- **Region**: ap-south-1 (Mumbai)
- **Load Balancer URL**: http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com

### VPC:
- **VPC ID**: vpc-08f084adaed25f590
- **VPC Name**: weelo-vpc
- **CIDR**: 10.0.0.0/16
- **Public Subnets**: weelo-subnet-public1-ap-south-1a, weelo-subnet-public2-ap-south-1b
- **Private Subnets**: weelo-subnet-private1-ap-south-1a, weelo-subnet-private2-ap-south-1b

### Security Groups:
- `weelo-alb-sg` - Load Balancer (HTTP 80, HTTPS 443 from anywhere)
- `weelo-ecs-sg` - ECS Tasks (Port 3000 from ALB only)
- `weelo-rds-sg` - Database (Port 5432 from ECS only)
- `weelo-redis-sg` - Redis (Port 6379 from ECS only)

### Database (RDS):
- **Instance**: weelodb
- **Engine**: PostgreSQL 15
- **Instance Class**: db.t3.micro (Free tier)
- **Username**: weelo_admin
- **Database Name**: weelo
- **Endpoint**: `weelodb.cdqoiou8wm0y.ap-south-1.rds.amazonaws.com`
- **Port**: 5432
- **Status**: Available
- **Connection String**: `postgresql://weelo_admin:PASSWORD@weelodb.cdqoiou8wm0y.ap-south-1.rds.amazonaws.com:5432/weelo`

### Redis (ElastiCache):
- **Name**: weeloredis
- **Type**: Serverless (Redis OSS)
- **Endpoint**: `weeloredis-zt8pfs.serverless.aps1.cache.amazonaws.com`
- **Port**: 6379
- **Connection URL**: `rediss://weeloredis-zt8pfs.serverless.aps1.cache.amazonaws.com:6379`
- **Note**: Uses `rediss://` (with 's') for TLS/SSL connection

### IAM:
- **SNS Policy**: `WeelSNSPublishPolicy` (arn:aws:iam::318774499084:policy/WeelSNSPublishPolicy)
- **Attached to**: `ecsTaskExecutionRole`
- **Permissions**: sns:Publish (for sending OTP SMS)

### ECS:
- **Cluster**: weelocluster
- **Service**: weelobackendtask-service-xxxxx
- **Task Definition**: weelobackendtask
- **Launch Type**: Fargate
- **CPU**: 0.5 vCPU
- **Memory**: 1 GB

### ECR:
- **Repository**: weelo-backend
- **Image URI**: 318774499084.dkr.ecr.ap-south-1.amazonaws.com/weelo-backend:latest

### Load Balancer:
- **Name**: weelo-alb
- **DNS**: weelo-alb-380596483.ap-south-1.elb.amazonaws.com
- **Target Group**: weelo-tg (Port 3000, Health: /health)

---

## 🔐 ENVIRONMENT VARIABLES NEEDED

### For Production (Task Definition):

```env
NODE_ENV=production
PORT=3000

# JWT Secrets (ALREADY GENERATED - USE THESE)
JWT_SECRET=e17e9eef7418a915e626ccfbdb12de32faf47b66638def1a4b607afb28298918
JWT_REFRESH_SECRET=1a633e28cafd0c3b2539af21e38a0cd830eeaab8edaafa0f6ea3947e9c97e32c

# Database (REPLACE YOUR_DB_PASSWORD with actual password)
DATABASE_URL=postgresql://weelo_admin:YOUR_DB_PASSWORD@weelodb.cdqoiou8wm0y.ap-south-1.rds.amazonaws.com:5432/weelo

# Redis (EXACT ENDPOINT)
REDIS_ENABLED=true
REDIS_URL=rediss://weeloredis-zt8pfs.serverless.aps1.cache.amazonaws.com:6379

# SMS Provider (AWS SNS ENABLED)
SMS_PROVIDER=aws-sns
AWS_SNS_REGION=ap-south-1

# IAM Policy "WeelSNSPublishPolicy" already attached to ecsTaskExecutionRole
```

### EXACT VALUES TO COPY:

| Key | Value |
|-----|-------|
| NODE_ENV | `production` |
| PORT | `3000` |
| JWT_SECRET | `e17e9eef7418a915e626ccfbdb12de32faf47b66638def1a4b607afb28298918` |
| JWT_REFRESH_SECRET | `1a633e28cafd0c3b2539af21e38a0cd830eeaab8edaafa0f6ea3947e9c97e32c` |
| DATABASE_URL | `postgresql://weelo_admin:YOUR_DB_PASSWORD@weelodb.cdqoiou8wm0y.ap-south-1.rds.amazonaws.com:5432/weelo` |
| REDIS_ENABLED | `true` |
| REDIS_URL | `rediss://weeloredis-zt8pfs.serverless.aps1.cache.amazonaws.com:6379` |
| SMS_PROVIDER | `aws-sns` |
| AWS_SNS_REGION | `ap-south-1` |
| AWS_LOCATION_ENABLED | `true` |
| AWS_REGION | `ap-south-1` |
| AWS_LOCATION_ROUTE_CALCULATOR | `weelo-routes` |
| AWS_LOCATION_PLACE_INDEX | `weelo-places` |

---

## 📱 SMS FLOW (OTP)

### Customer/Transporter Login:
1. User enters phone number
2. Backend generates OTP, hashes it, stores in Redis
3. Backend calls `smsService.sendOtp(phone, otp)`
4. AWS SNS sends real SMS to user's phone
5. User enters OTP
6. Backend verifies against hashed OTP in Redis
7. JWT tokens returned

### Driver Login:
1. Driver enters their phone number
2. Backend finds driver's transporter
3. OTP sent to **TRANSPORTER's phone** (not driver's)
4. Driver asks transporter for OTP
5. Driver enters OTP
6. Backend verifies and returns JWT tokens

---

## 📝 CODE CHANGES MADE FOR AWS SNS

### Files Modified:

1. **src/modules/auth/sms.service.ts**
   - Added `AWSSNSProvider` class
   - Uses `@aws-sdk/client-sns` package
   - Sends SMS via AWS SNS

2. **src/config/environment.ts**
   - Added `awsSns` config section (region, accessKeyId, secretAccessKey)
   - Changed default SMS_PROVIDER from 'console' to 'mock'

3. **src/core/config/env.validation.ts**
   - Added 'console' to valid SMS providers
   - Added AWS SNS validation

4. **src/modules/auth/auth.service.ts**
   - Added `import { smsService } from './sms.service'`
   - Added `smsService.sendOtp(phone, otp)` call after OTP generation

5. **src/modules/driver-auth/driver-auth.service.ts**
   - Added `import { smsService } from '../auth/sms.service'`
   - Added `smsService.sendOtp(transporter.phone, otp)` call

6. **package.json**
   - Added `@aws-sdk/client-sns` dependency

---

## 🚀 NEXT STEPS TO COMPLETE

### ✅ DONE:
- [x] Redis Endpoint obtained: `weeloredis-zt8pfs.serverless.aps1.cache.amazonaws.com:6379`
- [x] RDS Endpoint obtained: `weelodb.cdqoiou8wm0y.ap-south-1.rds.amazonaws.com`
- [x] IAM SNS Policy created and attached

### Step 1: Enable AWS SNS for SMS (DO THIS IN AWS CONSOLE)
1. Go to AWS Console → **SNS** → **Text messaging (SMS)**
2. Check if you're in **Sandbox mode** (default for new accounts)
3. If in Sandbox:
   - Click **"Add phone number"**
   - Add your test phone number (with +91 prefix)
   - Verify via OTP
4. For production: Click **"Request production access"**

### Step 2: Update ECS Task Definition (DO THIS IN AWS CONSOLE)
1. Go to **ECS** → **Task definitions** → **weelobackendtask**
2. Click **"Create new revision"**
3. Scroll to **Container definitions** → Click on **weelo-backend**
4. Scroll to **Environment variables** → Add these:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `JWT_SECRET` | `e17e9eef7418a915e626ccfbdb12de32faf47b66638def1a4b607afb28298918` |
| `JWT_REFRESH_SECRET` | `1a633e28cafd0c3b2539af21e38a0cd830eeaab8edaafa0f6ea3947e9c97e32c` |
| `DATABASE_URL` | `postgresql://weelo_admin:YOUR_PASSWORD@weelodb.cdqoiou8wm0y.ap-south-1.rds.amazonaws.com:5432/weelo` |
| `REDIS_ENABLED` | `true` |
| `REDIS_URL` | `rediss://weeloredis-zt8pfs.serverless.aps1.cache.amazonaws.com:6379` |
| `SMS_PROVIDER` | `aws-sns` |
| `AWS_SNS_REGION` | `ap-south-1` |

5. Click **"Create"**

### Step 3: Update ECS Service (DO THIS IN AWS CONSOLE)
1. Go to **ECS** → **Clusters** → **weelocluster**
2. Click on the **Service** tab
3. Select the service → Click **"Update"**
4. ✅ Check **"Force new deployment"**
5. Ensure **Task definition revision** is set to **LATEST**
6. Click **"Update"**

### Step 4: Wait & Test
1. Wait **2-3 minutes** for deployment
2. Check ECS → Tasks tab → Status should be **RUNNING**
3. Test health endpoint:
   ```
   curl http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/health
   ```
4. Expected response: `{"status":"ok","timestamp":"...","uptime":...}`

### Step 5: Test OTP Flow
1. Use your app or API to send OTP:
   ```
   curl -X POST http://weelo-alb-380596483.ap-south-1.elb.amazonaws.com/api/v1/auth/send-otp \
     -H "Content-Type: application/json" \
     -d '{"phone": "YOUR_PHONE", "role": "customer"}'
   ```
2. You should receive SMS on your phone!

---

## 🔒 IAM PERMISSIONS NEEDED

For ECS Task to send SMS via SNS, the Task Role needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sns:Publish"
      ],
      "Resource": "*"
    }
  ]
}
```

### How to Add:
1. Go to IAM → Roles
2. Find `ecsTaskExecutionRole` or create new role
3. Attach policy with SNS:Publish permission
4. Update Task Definition to use this role

---

## 📊 ARCHITECTURE DIAGRAM

```
                         INTERNET
                            │
                            ▼
                    ┌───────────────┐
                    │     ALB       │
                    │  (weelo-alb)  │
                    │   Port 80     │
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐
                    │   ECS Task    │
                    │  (Fargate)    │
                    │   Port 3000   │
                    └───────┬───────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
         ▼                  ▼                  ▼
┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐
│      RDS        │ │    Redis    │ │    AWS SNS      │
│  (PostgreSQL)   │ │(ElastiCache)│ │    (SMS)        │
│   Port 5432     │ │  Port 6379  │ │                 │
└─────────────────┘ └─────────────┘ └─────────────────┘
```

---

## 🆘 TROUBLESHOOTING

### If ECS Task keeps failing:
1. Check CloudWatch Logs: `/ecs/weelobackendtask` or `weelobackendtask`
2. Common issues:
   - Missing environment variables
   - Wrong Redis URL format
   - Database connection failed
   - SMS provider validation error

### If SMS not sending:
1. Check if `SMS_PROVIDER=aws-sns` is set
2. Check IAM permissions for SNS:Publish
3. Check if phone number is in E.164 format (+91xxxxxxxxxx)
4. If in SNS sandbox, add phone to verified list first

### If Redis connection fails:
1. Serverless Redis URL format: `rediss://<endpoint>:6379` (note: rediss with 's' for TLS)
2. Check security group allows traffic from ECS
3. Check VPC subnets are correct

---

## 💰 ESTIMATED MONTHLY COSTS

| Service | Cost |
|---------|------|
| ECS Fargate (0.5 vCPU, 1GB) | ~₹2,500 |
| RDS PostgreSQL (db.t3.micro) | ~₹2,500 |
| ElastiCache Redis (Serverless) | ~₹1,500 |
| ALB | ~₹2,000 |
| SNS SMS (100 free, then ₹0.18/SMS) | ~₹500 |
| **TOTAL** | **~₹9,000/month** |

---

## 📞 IMPORTANT CONTACTS/INFO

- **AWS Account**: weelo (318774499084)
- **Region**: ap-south-1 (Mumbai)
- **Backend Tech**: Node.js, TypeScript, Express, Socket.IO
- **Apps**: Android (Kotlin, Jetpack Compose)

---

*Last Updated: January 24, 2026*
*Status: In Progress - Configuring Redis & SNS*
