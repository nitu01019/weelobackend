import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config/environment';
import { db } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';

export type OtpHashStrategy = 'sha256' | 'sha256_or_bcrypt_compat';

export type OtpVerifyCode =
  | 'OTP_NOT_FOUND'
  | 'OTP_EXPIRED'
  | 'OTP_INVALID'
  | 'MAX_ATTEMPTS'
  | 'OTP_VERIFY_IN_PROGRESS';

export interface OtpChallengeIssueResult {
  expiresAt: Date;
  ttlSeconds: number;
  hash: string;
  storedInRedis: boolean;
  storedInDb: boolean;
}

export type OtpChallengeVerifyResult =
  | {
    ok: true;
    consumed: true;
  }
  | {
    ok: false;
    code: OtpVerifyCode;
    attemptsRemaining?: number;
  };

export interface OtpChallengeKey {
  phone: string;
  role: string;
}

interface OtpChallengeRecord {
  hash: string;
  expiresAt: string;
  attempts: number;
}

interface IssueChallengeParams {
  otp: string;
  redisKey: string;
  dbKey: OtpChallengeKey;
  logContext: Record<string, unknown>;
}

interface VerifyChallengeParams {
  otp: string;
  redisKey: string;
  dbKey: OtpChallengeKey;
  verifyLockKey: string;
  hashStrategy: OtpHashStrategy;
  logContext: Record<string, unknown>;
}

interface DeleteChallengeParams {
  redisKey: string;
  dbKey: OtpChallengeKey;
  logContext?: Record<string, unknown>;
}

class OtpChallengeService {
  private readonly verifyLockTtlMs = 3_000;

  async issueChallenge(params: IssueChallengeParams): Promise<OtpChallengeIssueResult> {
    const expiresAt = new Date(Date.now() + config.otp.expiryMinutes * 60 * 1000);
    const ttlSeconds = config.otp.expiryMinutes * 60;
    const hash = this.hashSha256(params.otp);

    const record: OtpChallengeRecord = {
      hash,
      expiresAt: expiresAt.toISOString(),
      attempts: 0
    };

    // LATENCY FIX: Run Redis and DB stores in parallel instead of sequentially.
    // Each store is independent — one failing should not delay the other.
    const REDIS_STORE_TIMEOUT_MS = 2000;

    const redisStorePromise = Promise.race([
      redisService.setJSON(params.redisKey, {
        otp: record.hash,
        expiresAt: record.expiresAt,
        attempts: 0
      }, ttlSeconds),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Redis store timed out')), REDIS_STORE_TIMEOUT_MS)
      )
    ]);

    // FIX: Pass Date object instead of ISO string for expires_at.
    // PostgreSQL rejects implicit text→timestamptz conversion when using
    // parameterised $4::timestamptz with a string value.
    const dbStorePromise = db.prisma?.$executeRawUnsafe(
      `INSERT INTO "OtpStore" (phone, role, otp, expires_at, attempts)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (phone, role) DO UPDATE SET otp = $3, expires_at = $4, attempts = 0`,
      params.dbKey.phone,
      params.dbKey.role,
      record.hash,
      expiresAt          // Date object — Prisma/pg driver handles timestamptz natively
    ) ?? Promise.resolve(0);

    const [redisResult, dbResult] = await Promise.allSettled([
      redisStorePromise,
      dbStorePromise
    ]);

    const storedInRedis = redisResult.status === 'fulfilled';
    const storedInDb = dbResult.status === 'fulfilled';

    if (!storedInRedis) {
      logger.warn('[OTP CHALLENGE] Redis store failed', {
        ...params.logContext,
        error: (redisResult as PromiseRejectedResult).reason?.message || 'unknown'
      });
    }
    if (!storedInDb) {
      logger.warn('[OTP CHALLENGE] DB store failed', {
        ...params.logContext,
        error: (dbResult as PromiseRejectedResult).reason?.message || 'unknown'
      });
    }

    return {
      expiresAt,
      ttlSeconds,
      hash,
      storedInRedis,
      storedInDb
    };
  }

  async deleteChallenge(params: DeleteChallengeParams): Promise<void> {
    await Promise.allSettled([
      redisService.deleteOtpWithAttempts(params.redisKey),
      db.prisma?.$executeRawUnsafe(
        `DELETE FROM "OtpStore" WHERE phone = $1 AND role = $2`,
        params.dbKey.phone,
        params.dbKey.role
      )
    ]);

    if (params.logContext) {
      logger.info('[OTP CHALLENGE] Challenge deleted', params.logContext);
    }
  }

  async verifyChallenge(params: VerifyChallengeParams): Promise<OtpChallengeVerifyResult> {
    const lockToken = uuidv4();
    let lockAcquired = false;
    let redisLockAvailable = true;

    try {
      try {
        const lockResult = await (redisService as any).client.eval(
          `
          if redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
            return 1
          else
            return 0
          end
          `,
          [params.verifyLockKey],
          [lockToken, String(this.verifyLockTtlMs)]
        );

        lockAcquired = Number(lockResult) === 1;
        if (!lockAcquired) {
          return { ok: false, code: 'OTP_VERIFY_IN_PROGRESS' };
        }
      } catch (error: any) {
        redisLockAvailable = false;
        logger.warn('[OTP CHALLENGE] Redis verify lock unavailable, using DB row lock fallback', {
          ...params.logContext,
          error: error?.message || 'unknown'
        });
      }

      if (!redisLockAvailable) {
        return await this.verifyWithDbRowLock(params);
      }

      return await this.verifyWithRedisLock(params);
    } finally {
      if (lockAcquired) {
        await this.releaseRedisVerifyLock(params.verifyLockKey, lockToken, params.logContext);
      }
    }
  }

  private async verifyWithRedisLock(params: VerifyChallengeParams): Promise<OtpChallengeVerifyResult> {
    const stored = await this.getChallengeRecord(params.redisKey, params.dbKey, params.logContext);
    if (!stored) {
      return { ok: false, code: 'OTP_NOT_FOUND' };
    }

    if (new Date() > new Date(stored.expiresAt)) {
      await this.deleteChallenge({ redisKey: params.redisKey, dbKey: params.dbKey });
      return { ok: false, code: 'OTP_EXPIRED' };
    }

    const maxAttempts = config.otp.maxAttempts;
    let currentAttempts = stored.attempts || 0;
    const redisAttempts = await redisService.getOtpAttempts(params.redisKey).catch(() => 0);
    if (redisAttempts > 0) {
      currentAttempts = Math.max(currentAttempts, redisAttempts);
    }

    if (currentAttempts >= maxAttempts) {
      await this.deleteChallenge({ redisKey: params.redisKey, dbKey: params.dbKey });
      return { ok: false, code: 'MAX_ATTEMPTS' };
    }

    const isValid = await this.verifyHash(params.otp, stored.hash, params.hashStrategy);
    if (!isValid) {
      let attemptsRemaining = maxAttempts - currentAttempts - 1;
      let maxReached = false;

      try {
        const attemptResult = await redisService.incrementOtpAttempts(params.redisKey, maxAttempts);
        attemptsRemaining = attemptResult.remaining;
        maxReached = !attemptResult.allowed;
      } catch {
        maxReached = attemptsRemaining <= 0;
      }

      try {
        await db.prisma?.$executeRawUnsafe(
          `UPDATE "OtpStore" SET attempts = attempts + 1 WHERE phone = $1 AND role = $2`,
          params.dbKey.phone,
          params.dbKey.role
        );
      } catch {
        // Best effort - DB is backup for Redis path
      }

      if (maxReached) {
        await this.deleteChallenge({ redisKey: params.redisKey, dbKey: params.dbKey });
        return { ok: false, code: 'MAX_ATTEMPTS' };
      }

      return {
        ok: false,
        code: 'OTP_INVALID',
        attemptsRemaining
      };
    }

    await this.deleteChallenge({ redisKey: params.redisKey, dbKey: params.dbKey });
    return { ok: true, consumed: true };
  }

  private async verifyWithDbRowLock(params: VerifyChallengeParams): Promise<OtpChallengeVerifyResult> {
    if (!db.prisma) {
      logger.error('[OTP CHALLENGE] DB row-lock fallback unavailable (db.prisma missing)', params.logContext);
      return { ok: false, code: 'OTP_NOT_FOUND' };
    }

    const maxAttempts = config.otp.maxAttempts;

    const txResult = await db.prisma.$transaction(async (tx: any) => {
      const rows: any[] = await tx.$queryRawUnsafe(
        `SELECT otp, expires_at, attempts
         FROM "OtpStore"
         WHERE phone = $1 AND role = $2
         LIMIT 1
         FOR UPDATE`,
        params.dbKey.phone,
        params.dbKey.role
      );

      if (!rows || rows.length === 0) {
        return { ok: false, code: 'OTP_NOT_FOUND' } as OtpChallengeVerifyResult;
      }

      const row = rows[0];
      const stored: OtpChallengeRecord = {
        hash: String(row.otp),
        expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
        attempts: Number(row.attempts || 0)
      };

      if (new Date() > new Date(stored.expiresAt)) {
        await tx.$executeRawUnsafe(
          `DELETE FROM "OtpStore" WHERE phone = $1 AND role = $2`,
          params.dbKey.phone,
          params.dbKey.role
        );
        return { ok: false, code: 'OTP_EXPIRED' } as OtpChallengeVerifyResult;
      }

      if (stored.attempts >= maxAttempts) {
        await tx.$executeRawUnsafe(
          `DELETE FROM "OtpStore" WHERE phone = $1 AND role = $2`,
          params.dbKey.phone,
          params.dbKey.role
        );
        return { ok: false, code: 'MAX_ATTEMPTS' } as OtpChallengeVerifyResult;
      }

      const isValid = await this.verifyHash(params.otp, stored.hash, params.hashStrategy);
      if (!isValid) {
        const nextAttempts = stored.attempts + 1;
        if (nextAttempts >= maxAttempts) {
          await tx.$executeRawUnsafe(
            `DELETE FROM "OtpStore" WHERE phone = $1 AND role = $2`,
            params.dbKey.phone,
            params.dbKey.role
          );
          return { ok: false, code: 'MAX_ATTEMPTS' } as OtpChallengeVerifyResult;
        }

        await tx.$executeRawUnsafe(
          `UPDATE "OtpStore" SET attempts = attempts + 1 WHERE phone = $1 AND role = $2`,
          params.dbKey.phone,
          params.dbKey.role
        );

        return {
          ok: false,
          code: 'OTP_INVALID',
          attemptsRemaining: maxAttempts - nextAttempts
        } as OtpChallengeVerifyResult;
      }

      await tx.$executeRawUnsafe(
        `DELETE FROM "OtpStore" WHERE phone = $1 AND role = $2`,
        params.dbKey.phone,
        params.dbKey.role
      );

      return { ok: true, consumed: true } as OtpChallengeVerifyResult;
    });

    // Mirror cleanup/attempt state back to Redis best-effort after DB fallback path.
    if (!txResult.ok) {
      if (txResult.code === 'OTP_EXPIRED' || txResult.code === 'MAX_ATTEMPTS') {
        await redisService.deleteOtpWithAttempts(params.redisKey).catch(() => undefined);
      } else if (txResult.code === 'OTP_INVALID') {
        await redisService.incrementOtpAttempts(params.redisKey, config.otp.maxAttempts).catch(() => undefined);
      }
    } else {
      await redisService.deleteOtpWithAttempts(params.redisKey).catch(() => undefined);
    }

    return txResult;
  }

  private async getChallengeRecord(
    redisKey: string,
    dbKey: OtpChallengeKey,
    logContext: Record<string, unknown>
  ): Promise<OtpChallengeRecord | null> {
    try {
      const raw = await redisService.getJSON<any>(redisKey);
      const parsed = this.parseRedisRecord(raw);
      if (parsed) return parsed;
    } catch (error: any) {
      logger.warn('[OTP CHALLENGE] Redis fetch failed', {
        ...logContext,
        error: error?.message || 'unknown'
      });
    }

    try {
      const rows: any[] | null = await db.prisma?.$queryRawUnsafe(
        `SELECT otp, expires_at, attempts FROM "OtpStore"
         WHERE phone = $1 AND role = $2 LIMIT 1`,
        dbKey.phone,
        dbKey.role
      );
      if (!rows || rows.length === 0) return null;

      const row = rows[0];
      return {
        hash: String(row.otp),
        expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
        attempts: Number(row.attempts || 0)
      };
    } catch (error: any) {
      logger.error('[OTP CHALLENGE] DB fetch failed', {
        ...logContext,
        error: error?.message || 'unknown'
      });
      return null;
    }
  }

  private parseRedisRecord(raw: any): OtpChallengeRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const hash = typeof raw.otp === 'string'
      ? raw.otp
      : (typeof raw.hashedOtp === 'string' ? raw.hashedOtp : null);
    const expiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt : null;
    if (!hash || !expiresAt) return null;
    return {
      hash,
      expiresAt,
      attempts: Number(raw.attempts || 0)
    };
  }

  private async verifyHash(otp: string, storedHash: string, strategy: OtpHashStrategy): Promise<boolean> {
    if (strategy === 'sha256') {
      return this.timingSafeSha256Compare(otp, storedHash);
    }

    if (this.isBcryptHash(storedHash)) {
      return bcrypt.compare(otp, storedHash);
    }

    return this.timingSafeSha256Compare(otp, storedHash);
  }

  private timingSafeSha256Compare(otp: string, storedHash: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(storedHash)) {
      return false;
    }

    const inputHash = this.hashSha256(otp);
    try {
      return crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(storedHash));
    } catch {
      return false;
    }
  }

  private hashSha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  private isBcryptHash(value: string): boolean {
    return /^\$2[aby]\$/.test(value);
  }

  private async releaseRedisVerifyLock(lockKey: string, lockToken: string, logContext: Record<string, unknown>): Promise<void> {
    try {
      await (redisService as any).client.eval(
        `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        else
          return 0
        end
        `,
        [lockKey],
        [lockToken]
      );
    } catch (error: any) {
      logger.warn('[OTP CHALLENGE] Failed to release Redis verify lock', {
        ...logContext,
        error: error?.message || 'unknown'
      });
    }
  }
}

export const otpChallengeService = new OtpChallengeService();

