import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  db: {
    url: requireEnv('DATABASE_URL'),
  },

  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },

  twilio: {
    accountSid: requireEnv('TWILIO_ACCOUNT_SID'),
    authToken: requireEnv('TWILIO_AUTH_TOKEN'),
    phoneNumber: requireEnv('TWILIO_PHONE_NUMBER'),
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID,
  },

  deepgram: {
    apiKey: requireEnv('DEEPGRAM_API_KEY'),
  },

  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
  },

  app: {
    baseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
    webhookBaseUrl: process.env.WEBHOOK_BASE_URL ?? 'http://localhost:3000/webhooks',
  },
} as const;
