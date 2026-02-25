import { validateEnvironment } from '../env.validation';

describe('tracking stream environment validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      JWT_SECRET: 'a'.repeat(64),
      JWT_REFRESH_SECRET: 'b'.repeat(64),
      SMS_PROVIDER: 'console',
      TRACKING_STREAM_ENABLED: 'false',
      TRACKING_STREAM_PROVIDER: 'none'
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('rejects enabled stream without provider', () => {
    process.env.TRACKING_STREAM_ENABLED = 'true';
    process.env.TRACKING_STREAM_PROVIDER = 'none';

    const result = validateEnvironment();

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('TRACKING_STREAM_ENABLED=true requires TRACKING_STREAM_PROVIDER'))).toBe(true);
  });

  it('rejects kinesis provider without stream name', () => {
    process.env.TRACKING_STREAM_ENABLED = 'true';
    process.env.TRACKING_STREAM_PROVIDER = 'kinesis';
    delete process.env.TRACKING_KINESIS_STREAM;

    const result = validateEnvironment();

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('TRACKING_KINESIS_STREAM is required'))).toBe(true);
  });

  it('accepts valid kinesis stream configuration', () => {
    process.env.TRACKING_STREAM_ENABLED = 'true';
    process.env.TRACKING_STREAM_PROVIDER = 'kinesis';
    process.env.TRACKING_KINESIS_STREAM = 'weelo-tracking-events-staging';

    const result = validateEnvironment();

    expect(result.valid).toBe(true);
  });
});

