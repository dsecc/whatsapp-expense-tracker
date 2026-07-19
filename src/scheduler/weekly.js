import { logger } from '../utils/logger.js';
import { getWeeklySummary } from '../sheets/client.js';

let schedulerInterval = null;

// Formatea el mensaje de resumen semanal con separacion ARS/USD
export function formatWeeklySummary(data) {
  const { breakdownARS, breakdownUSD, totalARS, totalUSD, count } = data;
  if (count === 0) return null;

  const lines = ['*Resumen semanal* 📊', ''];

  if (totalARS > 0) {
    lines.push('*EN PESOS:*');
    Object.entries(breakdownARS)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .forEach(([cat, monto]) => {
        lines.push('  ' + cat.charAt(0).toUpperCase() + cat.slice(1) + ': $' + monto.toLocaleString('es-AR'));
      });
    lines.push('  ─────────────────');
    lines.push('  *Total ARS: $' + totalARS.toLocaleString('es-AR') + '*');
    lines.push('');
  }

  if (totalUSD > 0) {
    lines.push('*EN DOLARES:*');
    Object.entries(breakdownUSD)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .forEach(([cat, monto]) => {
        lines.push('  ' + cat.charAt(0).toUpperCase() + cat.slice(1) + ': U$S ' + monto.toLocaleString('es-AR'));
      });
    lines.push('  ─────────────────');
    lines.push('  *Total USD: U$S ' + totalUSD.toLocaleString('es-AR') + '*');
    lines.push('');
  }

  lines.push('(' + count + ' gastos esta semana)');
  return lines.join('\n');
}

// Es domingo a las 23:00 (ventana de 1 minuto)?
function isScheduledTime() {
  const now = new Date();
  return now.getDay() === 0 && now.getHours() === 23 && now.getMinutes() === 0;
}

// Inicia el scheduler. getSock() devuelve el socket activo de Baileys.
export function startWeeklyScheduler(getSock, targetJid) {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
  if (!targetJid) {
    logger.warn('WHATSAPP_SUMMARY_JID no configurado, resumen semanal desactivado');
    return;
  }
  logger.info({ targetJid }, 'Scheduler semanal iniciado');

  schedulerInterval = setInterval(async () => {
    if (!isScheduledTime()) return;
    logger.info('Ejecutando resumen semanal automatico');
    try {
      const data = await getWeeklySummary();
      const msg  = formatWeeklySummary(data);
      if (!msg) { logger.info('Sin gastos esta semana, no se envia resumen'); return; }
      const sock = getSock();
      if (!sock) { logger.warn('Socket no disponible para enviar resumen semanal'); return; }
      await sock.sendMessage(targetJid, { text: msg });
      logger.info({ targetJid }, 'Resumen semanal enviado');
    } catch (err) {
      logger.error({ err }, 'Error enviando resumen semanal');
    }
  }, 60 * 1000);
}

export function stopWeeklyScheduler() {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
}
