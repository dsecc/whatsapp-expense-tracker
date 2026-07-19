import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { startWhatsAppClient } from './whatsapp/client.js';

async function main() {
  logger.info('Iniciando WhatsApp Expense Tracker...');

  try {
    // Forzar evaluacion de config (lanza si falta algo obligatorio)
    void config.anthropic.apiKey;
    void config.sheets.sheetId;
    logger.info('Configuracion verificada OK');
  } catch (err) {
    logger.error({ msg: err.message }, 'Error de configuracion - revisa el archivo .env');
    process.exit(1);
  }

  await startWhatsAppClient();
}

process.on('SIGINT', () => { logger.info('SIGINT recibido, cerrando...'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('SIGTERM recibido, cerrando...'); process.exit(0); });
process.on('unhandledRejection', (reason) => { logger.error({ reason }, 'Unhandled rejection'); });

main();
