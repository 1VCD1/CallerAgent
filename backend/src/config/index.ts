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
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
  },

  openai: {
    apiKey: requireEnv('OPENAI_API_KEY'), // used for LLM decisions + memory embeddings
  },

  firebase: {
    serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? null, // optional — used for FCM push
  },

  app: {
    baseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
    webhookBaseUrl: process.env.WEBHOOK_BASE_URL ?? 'http://localhost:3000/webhooks',
    apiKey: process.env.API_KEY ?? null,     // optional — if set, required on write endpoints
    sentryDsn: process.env.SENTRY_DSN ?? null, // optional — enables Sentry error tracking
  },
} as const;
