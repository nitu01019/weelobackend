# AWS SNS SMS Quota Increase Request Guide

## 📊 Current Status

**Current Limit**: 1 SMS/second
**Requested Limit**: 500 SMS/second
**Account**: 318774499084
**Region**: ap-south-1 (Mumbai)

---

## 🎯 Why We Need This

### Current Capacity
- 1 SMS/sec = 3,600 SMS/hour = 86,400 SMS/day
- **Bottleneck** for peak traffic

### Target Capacity
- 500 SMS/sec = 1.8M SMS/hour = 43M SMS/day
- Handles peak traffic: 500 concurrent OTP requests
- Supports millions of users

---

## 📝 How to Request Quota Increase

### Step 1: Open AWS Support Center
```
1. AWS Console → Support → Support Center
2. Click "Create case"
3. Case type: "Service limit increase"
```

### Step 2: Select Service
```
Service: Amazon Simple Notification Service (SNS)
Limit type: SMS
Region: Asia Pacific (Mumbai) - ap-south-1
```

### Step 3: Fill Request Details

**Limit Name**: Account Spending Limit (SMS)
**New Limit**: $10,000/month (allows ~500 SMS/sec)

**OR**

**Limit Name**: SMS Sending Rate
**New Limit**: 500 SMS/second

### Step 4: Use Case Description

```
Use Case: OTP Authentication for Logistics Platform

Description:
We operate Weelo, a logistics platform connecting customers with transporters in India. 
Our platform requires OTP authentication for:
- Customer login/signup
- Transporter/driver login
- Booking confirmations

Current user base: Growing rapidly
Expected peak traffic: 500 OTP requests/second during launch
Current limit (1 SMS/sec) is insufficient for production scale.

We use AWS SNS for SMS delivery (production access already approved).
Request increase to 500 SMS/second to support our production launch.

Use case: Transactional SMS (OTP authentication)
Opt-out mechanism: Standard AWS SNS opt-out
Compliance: Following TRAI DLT regulations for India
```

### Step 5: Submit & Wait
**Approval Time**: 24-48 hours (usually faster for India region)

---

## 🔍 Alternative: Batch Processing

While waiting for quota increase, handle bursts:

```typescript
// Queue OTPs if SNS rate limited
const otpQueue = new Queue('otp-sms', { 
  redis: redisConnection,
  limiter: {
    max: 1,     // 1 SMS
    duration: 1000  // per second
  }
});

// Process queue gradually
otpQueue.process(async (job) => {
  await snsService.sendSMS(job.data.phone, job.data.message);
});
```

**Impact**: SMS arrives in 1-5 seconds instead of instantly
**Benefit**: No request failures, just delayed SMS

---

## 📊 Cost Estimate

### SMS Pricing (AWS SNS India)
- ₹0.00645 per SMS (~$0.00008)
- 500 SMS/sec = 1.8M SMS/hour
- Cost: ₹11,610/hour ($140/hour)

### Monthly Estimate
- 100K users/day × 2 OTP each = 200K SMS/day
- 200K × ₹0.00645 = ₹1,290/day
- **Monthly**: ₹38,700 (~$470)

### Quota Request
**Spending limit**: $10,000/month
**Covers**: ~125M SMS/month
**More than enough** for production

---

## ✅ Current Workaround

**Until quota approved**:
1. OTP rate limiting (3 per 15 min) ✅
2. PM2 cluster mode (8x capacity) ✅
3. Queue-based SMS (smooth delivery) ⏳
4. Console fallback (development) ✅

---

*Request quota ASAP for production launch*
*Current limit sufficient for soft launch (< 3,600 OTP/hour)*
*Increase needed for full production scale*
