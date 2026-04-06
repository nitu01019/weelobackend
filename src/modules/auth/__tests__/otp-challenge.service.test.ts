import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

const mockRedisService: any = {
  setJSON: jest.fn(),
  deleteOtpWithAttempts: jest.fn(),
  getJSON: jest.fn(),
  getOtpAttempts: jest.fn(),
  incrementOtpAttempts: jest.fn(),
  eval: jest.fn()
};

const mockDbPrisma: any = {
  $executeRawUnsafe: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  $transaction: jest.fn()
};

jest.mock('../../../config/environment', () => ({
  config: {
    otp: {
      expiryMinutes: 5,
      maxAttempts: 3
    }
  }
}));

jest.mock('../../../shared/services/logger.service', () => ({
  logger: mockLogger
}));

jest.mock('../../../shared/services/redis.service', () => ({
  redisService: mockRedisService
}));

jest.mock('../../../shared/database/db', () => ({
  db: {
    prisma: mockDbPrisma
  }
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'lock-token')
}), { virtual: true });

import { otpChallengeService } from '../otp-challenge.service';

function resetMocks() {
  jest.clearAllMocks();
  mockRedisService.setJSON.mockResolvedValue(undefined);
  mockRedisService.deleteOtpWithAttempts.mockResolvedValue(undefined);
  mockRedisService.getJSON.mockResolvedValue(null);
  mockRedisService.getOtpAttempts.mockResolvedValue(0);
  mockRedisService.incrementOtpAttempts.mockResolvedValue({
    allowed: true,
    attempts: 1,
    remaining: 2
  });
  mockRedisService.eval.mockResolvedValue(1);

  mockDbPrisma.$executeRawUnsafe.mockResolvedValue(1);
  mockDbPrisma.$queryRawUnsafe.mockResolvedValue([]);
  mockDbPrisma.$transaction.mockImplementation(async (fn: any) =>
    fn({
      $queryRawUnsafe: jest.fn(),
      $executeRawUnsafe: jest.fn()
    })
  );
}

describe('OtpChallengeService', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('issues hashed OTP challenge and stores in Redis + DB', async () => {
    const result = await otpChallengeService.issueChallenge({
      otp: '123456',
      redisKey: 'otp:9999999999:transporter',
      dbKey: { phone: '9999999999', role: 'transporter' },
      logContext: { phone: '99****9999', role: 'transporter' }
    });

    expect(result.storedInRedis).toBe(true);
    expect(result.storedInDb).toBe(true);
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.hash).not.toBe('123456');
    expect(mockRedisService.setJSON).toHaveBeenCalledWith(
      'otp:9999999999:transporter',
      expect.objectContaining({
        otp: result.hash,
        attempts: 0
      }),
      300
    );
    expect(mockDbPrisma.$executeRawUnsafe).toHaveBeenCalled();
  });

  it('returns OTP_VERIFY_IN_PROGRESS when Redis lock is already held', async () => {
    mockRedisService.eval.mockResolvedValueOnce(0);

    const result = await otpChallengeService.verifyChallenge({
      otp: '123456',
      redisKey: 'otp:9999999999:transporter',
      dbKey: { phone: '9999999999', role: 'transporter' },
      verifyLockKey: 'otp:verify:lock:9999999999:transporter',
      hashStrategy: 'sha256',
      logContext: { phone: '99****9999', role: 'transporter' }
    });

    expect(result).toEqual({ ok: false, code: 'OTP_VERIFY_IN_PROGRESS' });
  });

  it('guarantees single-use under concurrent verify attempts (Redis lock path)', async () => {
    let lockHeld = false;
    let challengeExists = true;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const hash = crypto.createHash('sha256').update('123456').digest('hex');

    mockRedisService.eval.mockImplementation(async (script: string) => {
      if (script.includes("'NX'")) {
        if (lockHeld) return 0;
        lockHeld = true;
        return 1;
      }
      lockHeld = false;
      return 1;
    });

    mockRedisService.getJSON.mockImplementation(async () => {
      await barrier;
      if (!challengeExists) return null;
      return {
        otp: hash,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        attempts: 0
      };
    });

    mockRedisService.getOtpAttempts.mockResolvedValue(0);
    mockRedisService.deleteOtpWithAttempts.mockImplementation(async () => {
      challengeExists = false;
    });

    const p1 = otpChallengeService.verifyChallenge({
      otp: '123456',
      redisKey: 'otp:9999999999:transporter',
      dbKey: { phone: '9999999999', role: 'transporter' },
      verifyLockKey: 'otp:verify:lock:9999999999:transporter',
      hashStrategy: 'sha256',
      logContext: { phone: '99****9999', role: 'transporter' }
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const p2 = otpChallengeService.verifyChallenge({
      otp: '123456',
      redisKey: 'otp:9999999999:transporter',
      dbKey: { phone: '9999999999', role: 'transporter' },
      verifyLockKey: 'otp:verify:lock:9999999999:transporter',
      hashStrategy: 'sha256',
      logContext: { phone: '99****9999', role: 'transporter' }
    });

    releaseBarrier();
    const [r1, r2] = await Promise.all([p1, p2]);
    const results = [r1, r2];

    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(
      results.filter(
        (r) => !r.ok && (r as Exclude<typeof r, { ok: true }>).code === 'OTP_VERIFY_IN_PROGRESS'
      ).length
    ).toBe(1);
  });

  it('falls back to DB row lock when Redis verify lock is unavailable', async () => {
    const hash = crypto.createHash('sha256').update('654321').digest('hex');

    mockRedisService.eval.mockRejectedValueOnce(new Error('eval disabled'));

    const txQuery = jest.fn().mockResolvedValue([
      {
        otp: hash,
        expires_at: new Date(Date.now() + 60_000),
        attempts: 0
      }
    ]);
    const txExec = jest.fn().mockResolvedValue(1);
    mockDbPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        $queryRawUnsafe: txQuery,
        $executeRawUnsafe: txExec
      })
    );

    const result = await otpChallengeService.verifyChallenge({
      otp: '654321',
      redisKey: 'otp:8888888888:transporter',
      dbKey: { phone: '8888888888', role: 'transporter' },
      verifyLockKey: 'otp:verify:lock:8888888888:transporter',
      hashStrategy: 'sha256',
      logContext: { phone: '88****8888', role: 'transporter' }
    });

    expect(result).toEqual({ ok: true, consumed: true });
    expect(mockDbPrisma.$transaction).toHaveBeenCalled();
    expect(txQuery).toHaveBeenCalled();
    expect(txExec).toHaveBeenCalled();
  });

  it('supports legacy bcrypt hashes in compatibility mode', async () => {
    const bcryptHash = await bcrypt.hash('222222', 4);

    mockRedisService.getJSON.mockResolvedValue({
      hashedOtp: bcryptHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      attempts: 0
    });
    mockRedisService.getOtpAttempts.mockResolvedValue(0);

    const result = await otpChallengeService.verifyChallenge({
      otp: '222222',
      redisKey: 'driver-otp:7777777777',
      dbKey: { phone: '7777777777', role: 'driver' },
      verifyLockKey: 'driver-otp:verify:lock:7777777777',
      hashStrategy: 'sha256_or_bcrypt_compat',
      logContext: { driverPhone: '77****7777' }
    });

    expect(result).toEqual({ ok: true, consumed: true });
  });
});
