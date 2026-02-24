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

const mockDb = {
  prisma: {
    $executeRawUnsafe: jest.fn()
  },
  getUserByPhone: jest.fn(),
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

jest.mock('../../../shared/database/db', () => ({
  db: mockDb
}));

jest.mock('../../auth/sms.service', () => ({
  smsService: mockSmsService
}));

jest.mock('../../auth/otp-challenge.service', () => ({
  otpChallengeService: mockOtpChallengeService
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn((payload: any) => `${payload.role || 'token'}-jwt`)
}));

import { driverAuthService } from '../driver-auth.service';

describe('driver-auth.service OTP integration', () => {
  const driverRecord = {
    id: 'driver-1',
    phone: '9999999999',
    role: 'driver',
    name: 'Driver One',
    transporterId: 'transporter-1',
    isVerified: true,
    isActive: true,
    preferredLanguage: 'en',
    isProfileCompleted: true
  };

  const transporterRecord = {
    id: 'transporter-1',
    phone: '8888888888',
    role: 'transporter',
    name: 'Transporter One',
    businessName: 'Transporter Biz',
    isVerified: true,
    isActive: true
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.isProduction = true;

    mockDb.getUserByPhone.mockResolvedValue(driverRecord);
    mockDb.getUserById.mockResolvedValue(transporterRecord);
    mockOtpChallengeService.issueChallenge.mockResolvedValue({
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      ttlSeconds: 300,
      hash: 'hash',
      storedInRedis: true,
      storedInDb: true
    });
    mockOtpChallengeService.deleteChallenge.mockResolvedValue(undefined);
    mockOtpChallengeService.verifyChallenge.mockResolvedValue({ ok: false, code: 'OTP_VERIFY_IN_PROGRESS' });
    mockSmsService.sendOtp.mockResolvedValue(undefined);
  });

  it('sends driver OTP to transporter and cleans challenge on production SMS failure', async () => {
    mockSmsService.sendOtp.mockRejectedValueOnce(new Error('sns failed'));

    await expect(driverAuthService.sendOtp('9999999999')).rejects.toMatchObject({
      code: 'SMS_SEND_FAILED',
      statusCode: 503
    });

    expect(mockOtpChallengeService.issueChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        dbKey: { phone: '9999999999', role: 'driver' },
        redisKey: 'driver-otp:9999999999'
      })
    );
    expect(mockSmsService.sendOtp).toHaveBeenCalledWith('8888888888', '123456');
    expect(mockOtpChallengeService.deleteChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        dbKey: { phone: '9999999999', role: 'driver' },
        redisKey: 'driver-otp:9999999999',
        logContext: expect.objectContaining({ reason: 'sms_send_failed' })
      })
    );
  });

  it('maps shared OTP lock contention to driver-auth 409 response', async () => {
    await expect(driverAuthService.verifyOtp('9999999999', '123456')).rejects.toMatchObject({
      code: 'OTP_VERIFY_IN_PROGRESS',
      statusCode: 409
    });

    expect(mockOtpChallengeService.verifyChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        verifyLockKey: 'driver-otp:verify:lock:9999999999',
        hashStrategy: 'sha256_or_bcrypt_compat'
      })
    );
  });

  it('returns driver payload on successful verification with transporter lookup', async () => {
    mockOtpChallengeService.verifyChallenge.mockResolvedValueOnce({ ok: true, consumed: true });

    const result = await driverAuthService.verifyOtp('9999999999', '123456');

    expect(result.role).toBe('DRIVER');
    expect(result.driver.id).toBe('driver-1');
    expect(result.driver.transporterId).toBe('transporter-1');
    expect(result.driver.transporterName).toBe('Transporter One');
    expect(result.driver.isProfileCompleted).toBe(true);
  });
});

