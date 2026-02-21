#!/usr/bin/env node

/**
 * Fetches a bearer token for ZAP authenticated scans.
 *
 * Required env:
 * - STAGING_BASE_URL
 * - ZAP_LOGIN_PHONE
 * - ZAP_LOGIN_OTP
 */

const baseUrl = process.env.STAGING_BASE_URL;
const phone = process.env.ZAP_LOGIN_PHONE;
const otp = process.env.ZAP_LOGIN_OTP;

if (!baseUrl || !phone || !otp) {
  console.error('Missing STAGING_BASE_URL / ZAP_LOGIN_PHONE / ZAP_LOGIN_OTP');
  process.exit(1);
}

async function run() {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, otp })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Login failed:', response.status, JSON.stringify(data));
    process.exit(1);
  }

  const token = data?.data?.tokens?.accessToken;
  if (!token) {
    console.error('No access token found in login response');
    process.exit(1);
  }

  process.stdout.write(token);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
