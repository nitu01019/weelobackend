# 🔐 Weelo Backend - Security Guide

This document outlines the security measures implemented in the Weelo backend and provides guidance for maintaining security in production.

## Table of Contents

1. [Security Overview](#security-overview)
2. [Authentication & Authorization](#authentication--authorization)
3. [OTP Security](#otp-security)
4. [JWT Token Security](#jwt-token-security)
5. [Input Validation & Sanitization](#input-validation--sanitization)
6. [Rate Limiting](#rate-limiting)
7. [CORS Configuration](#cors-configuration)
8. [Production Deployment Checklist](#production-deployment-checklist)
9. [Security Best Practices](#security-best-practices)

---

## Security Overview

The Weelo backend implements multiple layers of security:

| Layer | Protection |
|-------|------------|
| **Transport** | HTTPS/TLS 1.2+ required in production |
| **Authentication** | OTP-based login + JWT tokens |
| **Authorization** | Role-based access control (RBAC) |
| **Input** | Zod schema validation + sanitization |
| **Rate Limiting** | Per-IP and per-phone limits |
| **Headers** | Helmet security headers (CSP, HSTS, etc.) |
| **Logging** | Sensitive data masked in logs |

---

## Authentication & Authorization

### Roles

| Role | Description | Permissions |
|------|-------------|-------------|
| `customer` | Books trucks | View bookings, create bookings |
| `transporter` | Owns vehicles/drivers | Manage fleet, accept bookings |
| `driver` | Drives trucks | View assigned trips, update location |
| `admin` | System admin | Full access |

### Auth Flow

```
1. User enters phone number
2. Server generates OTP (cryptographically secure)
3. OTP is hashed (bcrypt) and stored with expiry
4. OTP is sent via SMS (or logged in dev mode)
5. User enters OTP
6. Server verifies OTP (bcrypt compare)
7. JWT access token + refresh token issued
8. Access token used for API calls
9. Refresh token used to get new access tokens
```

---

## OTP Security

### Implementation

- **Generation**: Uses `crypto.randomInt()` (cryptographically secure)
- **Storage**: Only hashed OTP is stored (bcrypt with salt)
- **Expiry**: Default 5 minutes (configurable)
- **Attempts**: Maximum 3 attempts before OTP is invalidated
- **Logging**: Plain OTP is NEVER logged in production

### Configuration

```bash
OTP_EXPIRY_MINUTES=5
OTP_LENGTH=6
OTP_MAX_ATTEMPTS=3
```

### Code Location

- `src/shared/utils/crypto.utils.ts` - Secure OTP generation
- `src/modules/auth/auth.service.ts` - OTP handling

---

## JWT Token Security

### Secrets

**⚠️ CRITICAL: Generate unique secrets for production!**

```bash
# Generate JWT_SECRET (64 bytes = 512 bits)
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Generate JWT_REFRESH_SECRET (MUST be different!)
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Token Lifetimes

| Token | Default Lifetime | Use Case |
|-------|------------------|----------|
| Access Token | 7 days | API authentication |
| Refresh Token | 30 days | Getting new access tokens |

### Token Contents

```json
// Access Token Payload
{
  "userId": "uuid",
  "role": "customer|transporter|driver",
  "phone": "9876543210",
  "iat": 1234567890,
  "exp": 1234567890
}

// Refresh Token Payload
{
  "userId": "uuid",
  "type": "refresh",
  "iat": 1234567890,
  "exp": 1234567890
}
```

---

## Input Validation & Sanitization

### Validation (Zod Schemas)

All inputs are validated using Zod schemas:

```typescript
// Example: Phone number validation
const phoneSchema = z.string()
  .transform(val => val.replace(/^(\+91|91)/, ''))
  .refine(val => /^[6-9]\d{9}$/.test(val), {
    message: 'Invalid phone number'
  });
```

### Sanitization

The `security.middleware.ts` sanitizes all inputs:

- Removes `<script>` tags
- Escapes HTML entities
- Removes SQL injection patterns
- Blocks suspicious requests

### Code Location

- `src/shared/utils/validation.utils.ts` - Zod schemas
- `src/shared/middleware/security.middleware.ts` - Sanitization

---

## Rate Limiting

### Limits

| Endpoint Type | Window | Max Requests | Key |
|---------------|--------|--------------|-----|
| General API | 15 min | 100 | IP address |
| Auth endpoints | 15 min | 10 | IP address |
| OTP requests | 10 min | 5 | Phone number |
| Profile updates | 1 min | 30 | User ID |
| Location tracking | 1 min | 120 | User ID |

### Scalability

For horizontal scaling (multiple servers), enable Redis:

```bash
REDIS_ENABLED=true
REDIS_URL=redis://your-redis-host:6379
```

---

## CORS Configuration

### Development

```bash
CORS_ORIGIN=*
```

### Production

```bash
CORS_ORIGIN=https://weelo.app,https://captain.weelo.app
```

---

## Production Deployment Checklist

### ✅ Before Going Live

```bash
# 1. Set production environment
NODE_ENV=production

# 2. Generate and set JWT secrets
JWT_SECRET=<64-byte-hex-string>
JWT_REFRESH_SECRET=<different-64-byte-hex-string>

# 3. Enable Redis for scalability
REDIS_ENABLED=true
REDIS_URL=redis://production-redis:6379

# 4. Restrict CORS
CORS_ORIGIN=https://weelo.app,https://captain.weelo.app

# 5. Configure SMS provider
SMS_PROVIDER=twilio  # or msg91
TWILIO_ACCOUNT_SID=<your-sid>
TWILIO_AUTH_TOKEN=<your-token>
TWILIO_PHONE_NUMBER=<your-number>

# 6. Set appropriate log level
LOG_LEVEL=info

# 7. Ensure HTTPS is configured
# (handled by load balancer/reverse proxy)
```

### ✅ Infrastructure

- [ ] HTTPS/TLS configured on load balancer
- [ ] SSL certificates valid and auto-renewing
- [ ] Firewall rules allow only necessary ports
- [ ] Database backups configured
- [ ] Redis persistence enabled
- [ ] Monitoring and alerting set up
- [ ] Log aggregation configured

---

## Security Best Practices

### For Backend Developers

1. **Never log sensitive data**
   ```typescript
   // ❌ BAD
   logger.info(`OTP for ${phone}: ${otp}`);
   
   // ✅ GOOD
   logger.info('OTP generated', { phone: maskForLogging(phone) });
   ```

2. **Always validate inputs**
   ```typescript
   // ❌ BAD
   const { phone } = req.body;
   
   // ✅ GOOD
   const { phone } = validateSchema(phoneSchema, req.body);
   ```

3. **Use parameterized queries** (when using SQL)
   ```typescript
   // ❌ BAD
   db.query(`SELECT * FROM users WHERE phone = '${phone}'`);
   
   // ✅ GOOD
   db.query('SELECT * FROM users WHERE phone = $1', [phone]);
   ```

4. **Check authorization on every request**
   ```typescript
   // Always verify user has access to the resource
   if (booking.customerId !== req.userId) {
     throw new AppError(403, 'FORBIDDEN', 'Access denied');
   }
   ```

### For DevOps/Infrastructure

1. **Use secrets management** (AWS Secrets Manager, HashiCorp Vault)
2. **Enable audit logging** for security events
3. **Implement IP whitelisting** where possible
4. **Regular security updates** for all dependencies
5. **Penetration testing** before major releases

---

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** create a public GitHub issue
2. Email: security@weelo.in
3. Include detailed reproduction steps
4. Allow reasonable time for fix before disclosure

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2024-01 | Initial security implementation |
| 1.1 | 2024-01 | Added crypto-secure OTP, removed plain OTP storage |

