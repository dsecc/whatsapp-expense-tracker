import dotenv from 'dotenv';
dotenv.config();

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Variable de entorno faltante: ${key}`);
  return val;
}

function optional(key, fallback = '') {
  return process.env[key] || fallback;
}

export const config = {
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
  },
  openai: {
    apiKey: optional('OPENAI_API_KEY'),
  },
  whatsapp: {
    phoneNumber: optional('WHATSAPP_PHONE_NUMBER'),
    authMethod: optional('WHATSAPP_AUTH_METHOD', 'qr'),
    sessionDir: '/app/data/wa-session',
    summaryJid: optional('WHATSAPP_SUMMARY_JID'), // para resumen semanal automatico
  },
  files: {
    dir: '/app/data/files',
  },
  sheets: {
    sheetId: required('GOOGLE_SHEET_ID'),
    serviceAccountEmail: required('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    serviceAccountKey: required('GOOGLE_SERVICE_ACCOUNT_KEY'),
    sheetName: optional('GOOGLE_SHEET_NAME', 'Gastos'),
  },
  app: {
    logLevel: optional('LOG_LEVEL', 'info'),
    port: parseInt(optional('PORT', '3000')),
    nodeEnv: optional('NODE_ENV', 'production'),
  },
};
