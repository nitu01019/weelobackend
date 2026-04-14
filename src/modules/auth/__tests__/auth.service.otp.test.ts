import { AppError } from '../../../shared/types/error.types';

const mockConfig = {
  otp: {
    length: 6,
    expiryMinutes: 5,
    maxAttempts: 3
  },
  jwt: {
    secret: 'secret',
    refreshSecret: 'refresh',
    expiresIn: '1h',
    refreshExpiresIn: '7d'
  },
  isProduction: true,
  isDevelopment: false
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

const mockOtpChallengeService = {
  issueChallenge: jest.fn(),
  deleteChallenge: jest.fn(),
  verifyChallenge: jest.fn()
};

const mockSmsService = {
  sendOtp: jest.fn()
};

const mockRedisService = {
  setJSON: jest.fn(),
  sAdd: jest.fn(),
  getJSON: jest.fn(),
  sMembers: jest.fn(),
  del: jest.fn(),
  exists: jest.fn().mockResolvedValue(false),  // M1: OTP cooldown check
  set: jest.fn().mockResolvedValue(undefined),  // M1: OTP cooldown write
};

const mockDb = {
  prisma: {
    $executeRawUnsafe: jest.fn()
  },
  getUserByPhone: jest.fn(),
  createUser: jest.fn(),
  getUserById: jest.fn()
};

jest.mock('../../../config/environment', () => ({
  config: mockConfig
}));

jest.mock('../../../shared/services/logger.service', () => ({
  logger: mockLogger
}));

jest.mock('../../../shared/utils/crypto.utils', () => ({
  generateSecureOTP: jest.fn(() => '123456'),
  maskForLogging: jest.fn((phone: string) => `masked:${phone}`)
}));

jest.mock('../../../shared/services/redis.service', () => ({
  redisService: mockRedisService
}));

jest.mock('../../../shared/database/db', () => ({
  db: mockDb
}));

jest.mock('../sms.service', () => ({
  smsService: mockSmsService
}));

jest.mock('../otp-challenge.service', () => ({
  otpChallengeService: mockOtpChallengeService
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'token'),
  verify: jest.fn()
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'uuid-1')
}), { virtual: true });

import { authService } from '../auth.service';

describe('auth.service OTP integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.isProduction = true;

    mockOtpChallengeService.issueChallenge.mockResolvedValue({
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      ttlSeconds: 300,
      hash: 'hash',
      storedInRedis: true,
      storedInDb: true
    });
    mockOtpChallengeService.deleteChallenge.mockResolvedValue(undefined);
    mockOtpChallengeService.verifyChallenge.mockResolvedValue({ ok: false, code: 'OTP_VERIFY_IN_PROGRESS' });

    mockSmsService.sendOtp.mockRejectedValue(new Error('sns failed'));
    mockRedisService.setJSON.mockResolvedValue(undefined);
    mockRedisService.sAdd.mockResolvedValue(undefined);
  });

  it('cleans up OTP challenge asynchronously when production SMS send fails (fire-and-forget)', async () => {
    // With fire-and-forget, sendOtp resolves immediately even if SMS fails
    const result = await authService.sendOtp('9999999999', 'transporter' as any);
    expect(result).toHaveProperty('expiresIn', 300);

    // Flush microtasks so the .catch() cleanup runs
    await new Promise(resolve => setImmediate(resolve));

    expect(mockOtpChallengeService.issueChallenge).toHaveBeenCalled();
    expect(mockOtpChallengeService.deleteChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        redisKey: 'otp:9999999999:transporter',
        dbKey: { phone: '9999999999', role: 'transporter' },
        logContext: expect.objectContaining({ reason: 'sms_send_failed' })
      })
    );
  });

  it('maps shared OTP lock contention to auth 409 response', async () => {
    await expect(authService.verifyOtp('9999999999', '123456', 'transporter' as any)).rejects.toMatchObject({
      code: 'OTP_VERIFY_IN_PROGRESS',
      statusCode: 409
    });

    expect(mockOtpChallengeService.verifyChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        verifyLockKey: 'otp:verify:lock:9999999999:transporter',
        hashStrategy: 'sha256'
      })
    );
  });

  it('maps not-found challenge to legacy INVALID_OTP auth response', async () => {
    mockOtpChallengeService.verifyChallenge.mockResolvedValueOnce({ ok: false, code: 'OTP_NOT_FOUND' });

    await expect(authService.verifyOtp('9999999999', '123456', 'transporter' as any)).rejects.toMatchObject({
      code: 'INVALID_OTP',
      statusCode: 400
    });
  });
});
