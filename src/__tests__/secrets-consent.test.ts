export {};

import * as fs from 'fs';
import * as path from 'path';

describe('Secrets Manager', () => {
  it('secrets module exists', () => {
    const secretsPath = path.join(__dirname, '..', 'config', 'secrets.ts');
    expect(fs.existsSync(secretsPath)).toBe(true);
  });

  it('loadSecrets is exported', () => {
    const { loadSecrets } = require('../config/secrets');
    expect(typeof loadSecrets).toBe('function');
  });

  it('loadSecrets returns a promise', () => {
    const { loadSecrets } = require('../config/secrets');
    const result = loadSecrets();
    expect(result).toBeInstanceOf(Promise);
    return result; // Wait for it
  });

  it('does not throw in development mode', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const { loadSecrets } = require('../config/secrets');
    await expect(loadSecrets()).resolves.toBeUndefined();
    process.env.NODE_ENV = originalEnv;
  });
});
