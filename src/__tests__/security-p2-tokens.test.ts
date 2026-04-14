export {};

import jwt from 'jsonwebtoken';

describe('JWT Security', () => {
  const testSecret = 'test-secret-key-for-testing-only';

  describe('Algorithm Pinning', () => {
    it('tokens signed with HS256 are valid', () => {
      const token = jwt.sign({ userId: 'test' }, testSecret, { algorithm: 'HS256' });
      const decoded = jwt.verify(token, testSecret, { algorithms: ['HS256'] });
      expect((decoded as any).userId).toBe('test');
    });

    it('tokens with none algorithm are rejected', () => {
      // Create a token that tries to use 'none' algorithm
      expect(() => {
        jwt.verify(
          'eyJ0eXAiOiJKV1QiLCJhbGciOiJub25lIn0.eyJ1c2VySWQiOiJ0ZXN0In0.',
          testSecret,
          { algorithms: ['HS256'] }
        );
      }).toThrow();
    });
  });

  describe('Token Expiry', () => {
    it('expired tokens are rejected', () => {
      const token = jwt.sign({ userId: 'test' }, testSecret, {
        algorithm: 'HS256',
        expiresIn: '0s',
      });
      // Wait a tick for expiry
      expect(() => {
        jwt.verify(token, testSecret, { algorithms: ['HS256'] });
      }).toThrow(/expired/i);
    });

    it('valid tokens with future expiry are accepted', () => {
      const token = jwt.sign({ userId: 'test' }, testSecret, {
        algorithm: 'HS256',
        expiresIn: '1h',
      });
      const decoded = jwt.verify(token, testSecret, { algorithms: ['HS256'] }) as any;
      expect(decoded.userId).toBe('test');
    });
  });
});
