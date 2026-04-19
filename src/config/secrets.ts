import { logger } from '../shared/services/logger.service';

interface SecretsConfig {
  DATABASE_URL?: string;
  JWT_SECRET?: string;
  JWT_REFRESH_SECRET?: string;
  GOOGLE_MAPS_API_KEY?: string;
  EXOTEL_API_KEY?: string;
  EXOTEL_API_TOKEN?: string;
}

/**
 * Load secrets from AWS Secrets Manager in production.
 * Falls back to environment variables in development.
 *
 * Call this BEFORE initializing the application.
 */
export async function loadSecrets(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    logger.info('Development mode: using environment variables for secrets');
    return;
  }

  const secretId = process.env.AWS_SECRET_ID || 'weelo/production/secrets';

  try {
    // Dynamic require to avoid needing @aws-sdk types at compile time.
    // The package is only installed in the production Docker image.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const awsSm = require('@aws-sdk/client-secrets-manager') as {
      SecretsManagerClient: new (cfg: { region: string }) => {
        send: (cmd: unknown) => Promise<{ SecretString?: string }>;
      };
      GetSecretValueCommand: new (cfg: { SecretId: string }) => unknown;
    };

    const client = new awsSm.SecretsManagerClient({
      region: process.env.AWS_REGION || 'ap-south-1',
    });

    const command = new awsSm.GetSecretValueCommand({ SecretId: secretId });
    const response = await client.send(command);

    if (!response.SecretString) {
      logger.warn('Secrets Manager returned empty secret');
      return;
    }

    const secrets: SecretsConfig = JSON.parse(response.SecretString);

    // Inject into process.env (only if not already set)
    if (secrets.DATABASE_URL && !process.env.DATABASE_URL) {
      process.env.DATABASE_URL = secrets.DATABASE_URL;
    }
    if (secrets.JWT_SECRET && !process.env.JWT_SECRET) {
      process.env.JWT_SECRET = secrets.JWT_SECRET;
    }
    if (secrets.JWT_REFRESH_SECRET && !process.env.JWT_REFRESH_SECRET) {
      process.env.JWT_REFRESH_SECRET = secrets.JWT_REFRESH_SECRET;
    }
    if (secrets.GOOGLE_MAPS_API_KEY && !process.env.GOOGLE_MAPS_API_KEY) {
      process.env.GOOGLE_MAPS_API_KEY = secrets.GOOGLE_MAPS_API_KEY;
    }

    logger.info('Secrets loaded from AWS Secrets Manager');
  } catch (error: unknown) {
    logger.error('Failed to load secrets from AWS Secrets Manager', {
      error: error instanceof Error ? error.message : String(error),
      secretId,
    });
    // Don't throw -- fall back to env vars
    logger.warn('Falling back to environment variables for secrets');
  }
}
