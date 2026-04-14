export {};

import jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';

describe('Auth Regression Suite', () => {
  const testSecret = 'test-secret-key-12345';

  describe('JWT Algorithm Pinning', () => {
    it('HS256 tokens are accepted', () => {
      const token = jwt.sign({ userId: 'u1', role: 'customer' }, testSecret, { algorithm: 'HS256' });
      const decoded = jwt.verify(token, testSecret, { algorithms: ['HS256'] }) as any;
      expect(decoded.userId).toBe('u1');
    });

    it('none algorithm tokens are rejected', () => {
      expect(() => {
        jwt.verify(
          'eyJ0eXAiOiJKV1QiLCJhbGciOiJub25lIn0.eyJ1c2VySWQiOiJ0ZXN0In0.',
          testSecret,
          { algorithms: ['HS256'] }
        );
      }).toThrow();
    });

    it('auth middleware source pins to HS256', () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'shared', 'middleware', 'auth.middleware.ts'),
        'utf-8'
      );
      expect(content).toContain("algorithms: ['HS256']");
    });

    it('auth service uses jwt.sign for token generation', () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'modules', 'auth', 'auth.service.ts'),
        'utf-8'
      );
      expect(content).toContain('jwt.sign(');
    });
  });

  describe('Token Expiry', () => {
    it('expired token throws', () => {
      const token = jwt.sign({ userId: 'u1' }, testSecret, { algorithm: 'HS256', expiresIn: '0s' });
      expect(() => jwt.verify(token, testSecret, { algorithms: ['HS256'] })).toThrow();
    });

    it('valid token does not throw', () => {
      const token = jwt.sign({ userId: 'u1' }, testSecret, { algorithm: 'HS256', expiresIn: '1h' });
      expect(() => jwt.verify(token, testSecret, { algorithms: ['HS256'] })).not.toThrow();
    });
  });

  describe('Rate Limiter Exists', () => {
    it('rate limiter middleware exports authRateLimiter', () => {
      const mod = require('../shared/middleware/rate-limiter.middleware');
      expect(mod.authRateLimiter).toBeDefined();
    });
  });

  describe('Presigned URL TTL', () => {
    it('s3 service has configured TTL for presigned URLs', () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'shared', 'services', 's3-upload.service.ts'),
        'utf-8'
      );
      // Current config: 604800 (7 days) for Instagram-style long-lived URLs
      expect(content).toMatch(/expiresIn:\s*604800/);
    });
  });
});
