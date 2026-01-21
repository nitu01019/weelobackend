# 🚛 Weelo Backend

> **Production-Ready Backend for Logistics & Transportation Platform**
> 
> Designed to scale to **millions of users** on AWS infrastructure.

[![Node.js](https://img.shields.io/badge/Node.js-20.x-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Express](https://img.shields.io/badge/Express-4.x-lightgrey.svg)](https://expressjs.com/)

---

## 🎯 Overview

**Single Backend** serving **BOTH Android Apps**:
- 📱 **Weelo Customer App** - For customers booking trucks
- 🚛 **Weelo Captain App** - For Transporters & Drivers

---

## 🚀 Quick Start

### Prerequisites
- Node.js 20.x or higher
- npm 10.x or higher
- (Optional) Docker & Docker Compose
- (Optional) Redis for caching/sessions

### Installation

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Start development server
npm run dev
```

Server runs at: `http://localhost:3000`

### Docker (Full Stack)

```bash
# Start API + PostgreSQL + Redis
npm run docker:dev

# View logs
npm run docker:logs

# Stop all
npm run docker:down
```

---

## 📁 Project Structure

```
src/
├── server.ts           # Main entry point
├── cluster.ts          # Multi-core production mode
│
├── core/               # 🎯 Core Framework
│   ├── constants/      # Enums, status codes, config
│   ├── errors/         # Custom error classes
│   ├── responses/      # Standardized API responses
│   └── config/         # Environment validation
│
├── config/             # ⚙️ Configuration
│   ├── environment.ts  # Config loader
│   └── aws.config.ts   # AWS settings
│
├── shared/             # 🔧 Shared Utilities
│   ├── middleware/     # Auth, rate-limit, security
│   ├── services/       # Logger, cache, socket, FCM
│   ├── database/       # Database abstraction
│   ├── monitoring/     # Prometheus metrics
│   └── resilience/     # Circuit breakers, queues
│
└── modules/            # 📦 Feature Modules
    ├── auth/           # OTP authentication
    ├── booking/        # Booking management
    ├── vehicle/        # Vehicle CRUD
    ├── tracking/       # GPS tracking
    ├── driver/         # Driver operations
    ├── transporter/    # Transporter operations
    ├── pricing/        # Fare calculation
    ├── broadcast/      # Booking broadcasts
    └── assignment/     # Driver assignments
```

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for detailed documentation.

---

## 🔧 NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Development with hot reload |
| `npm run build` | Build TypeScript |
| `npm start` | Start single process |
| `npm run start:cluster` | **Multi-core production mode** |
| `npm run start:prod` | Production with NODE_ENV=production |
| `npm run docker:dev` | Start Docker development stack |
| `npm run docker:build` | Build Docker image |
| `npm run health` | Check health endpoint |
| `npm run metrics` | View Prometheus metrics |

---

## 🌐 API Endpoints

### Health & Monitoring
```
GET  /health           # Quick health check (load balancers)
GET  /health/ready     # Readiness probe (K8s/ECS)
GET  /health/detailed  # Full system diagnostics
GET  /metrics          # Prometheus metrics
GET  /version          # App version info
```

### Authentication
```
POST /api/v1/auth/send-otp     # Send OTP to phone
POST /api/v1/auth/verify-otp   # Verify OTP & get tokens
POST /api/v1/auth/refresh      # Refresh access token
POST /api/v1/auth/logout       # Logout user
```

### Bookings (Customer)
```
POST /api/v1/bookings          # Create booking
GET  /api/v1/bookings          # List my bookings
GET  /api/v1/bookings/:id      # Get booking details
PUT  /api/v1/bookings/:id/cancel  # Cancel booking
```

### Vehicles (Transporter)
```
GET  /api/v1/vehicles          # List my vehicles
POST /api/v1/vehicles          # Add vehicle
PUT  /api/v1/vehicles/:id      # Update vehicle
DELETE /api/v1/vehicles/:id    # Remove vehicle
```

### Tracking (Real-time)
```
POST /api/v1/tracking/location    # Update driver location
GET  /api/v1/tracking/:bookingId  # Get booking location
WS   /socket                      # Real-time WebSocket
```

📚 See **[API_DOCUMENTATION.md](./API_DOCUMENTATION.md)** for complete reference.

---

## ⚙️ Environment Variables

### Required
```env
JWT_SECRET=your-secret-min-32-characters-long
JWT_REFRESH_SECRET=your-refresh-secret-min-32-characters
```

### Optional (Development)
```env
PORT=3000
NODE_ENV=development
REDIS_ENABLED=false
SMS_PROVIDER=mock
```

### Production
See **[.env.production.example](./.env.production.example)** for full configuration.

---

## 🏗️ Production Features

### Scalability
- ✅ **Multi-Core Clustering** - Uses all CPU cores
- ✅ **Circuit Breakers** - Graceful failure handling
- ✅ **Request Queuing** - High load protection
- ✅ **Connection Pooling** - Database optimization
- ✅ **Redis Caching** - Session, rate-limit, response cache

### Security
- ✅ Helmet.js security headers
- ✅ Rate limiting (configurable)
- ✅ JWT authentication with refresh tokens
- ✅ Input validation (Zod)
- ✅ SQL injection protection
- ✅ XSS/CSRF protection
- ✅ CORS configuration

### Monitoring
- ✅ **Prometheus Metrics** - `/metrics` endpoint
- ✅ **Health Checks** - Liveness & readiness probes
- ✅ **Winston Logging** - Structured JSON logs
- ✅ **Request Tracing** - Request ID correlation

---

## 🐳 Docker Deployment

### Build & Run
```bash
# Build production image
docker build -t weelo-backend:latest .

# Run with environment file
docker run -p 3000:3000 --env-file .env.production weelo-backend:latest
```

### Docker Compose (Local Dev)
```bash
docker-compose up -d      # Start all services
docker-compose logs -f    # View logs
docker-compose down       # Stop services
```

---

## ☁️ AWS Deployment

Recommended architecture for millions of users:

```
Route 53 → CloudFront → ALB → ECS Fargate (Auto-scaling)
                                    ↓
                           ElastiCache Redis
                                    ↓
                           RDS PostgreSQL
```

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for detailed AWS setup.

---

## 👨‍💻 Development Guide

### Adding a New Module

1. Create folder: `src/modules/your-module/`
2. Add files:
   - `your-module.routes.ts` - Route definitions
   - `your-module.service.ts` - Business logic
   - `your-module.schema.ts` - Zod validation
   - `index.ts` - Barrel exports
3. Register routes in `src/server.ts`
4. Update documentation

### Code Standards

- **TypeScript** strict mode enabled
- **Zod** for input validation
- **Async/await** (no callbacks)
- Use **custom error classes** from `@core/errors`
- Use **ApiResponse** for standardized responses
- Use **constants** from `@core/constants`

### Key Files

| Task | File |
|------|------|
| Add endpoint | `src/modules/<module>/<module>.routes.ts` |
| Add business logic | `src/modules/<module>/<module>.service.ts` |
| Add validation | `src/modules/<module>/<module>.schema.ts` |
| Add constant/enum | `src/core/constants/index.ts` |
| Add error type | `src/core/errors/AppError.ts` |

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | System architecture & design |
| **[API_DOCUMENTATION.md](./API_DOCUMENTATION.md)** | Complete API reference |
| **[API_QUICK_REFERENCE.md](./API_QUICK_REFERENCE.md)** | Quick API guide |
| **[CODING_STANDARDS.md](./CODING_STANDARDS.md)** | Code conventions |
| **[SECURITY.md](./SECURITY.md)** | Security guidelines |

---

## 📄 License

Proprietary - Weelo Logistics. All rights reserved.

---

**Version:** 2.0.0  
**Last Updated:** January 2024
