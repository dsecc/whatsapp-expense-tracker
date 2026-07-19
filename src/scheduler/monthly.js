import { logger } from '../utils/logger.js';
import { getReporteMensual } from '../sheets/client.js';

let schedulerInterval = null;

// Formatea el reporte mensual completo para WhatsApp
export function formatReporteMensual(data) {
  const { nombreMes, breakdownARS, breakdownUSD, totalARS, totalUSD, ayuda, deudas } = data;
  const lines = [];

  lines.push('*Reporte de ' + nombreMes + '* 📊');
  lines.push('');

  // Gastos en ARS
  if (totalARS > 0) {
    lines.push('*GASTOS EN PESOS*');
    Object.entries(breakdownARS)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .forEach(([cat, monto]) => {
        const nombre = cat.charAt(0).toUpperCase() + cat.slice(1);
        lines.push('  ' + nombre + ': $' + monto.toLocaleString('es-AR'));
      });
    lines.push('  ─────────────────');
    lines.push('  *Total ARS: $' + totalARS.toLocaleString('es-AR') + '*');
    lines.push('');
  }

  // Gastos en USD
  if (totalUSD > 0) {
    lines.push('*GASTOS EN DÓLARES*');
    Object.entries(breakdownUSD)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .forEach(([cat, monto]) => {
        const nombre = cat.charAt(0).toUpperCase() + cat.slice(1);
        lines.push('  ' + nombre + ': U$S ' + monto.toLocaleString('es-AR'));
      });
    lines.push('  ─────────────────');
    lines.push('  *Total USD: U$S ' + totalUSD.toLocaleString('es-AR') + '*');
    lines.push('');
  }

  // Ayuda recibida
  if (ayuda.count > 0) {
    lines.push('*AYUDA RECIBIDA*');
    Object.entries(ayuda.porOrigen)
      .sort(([, a], [, b]) => b - a)
      .forEach(([origen, monto]) => {
        lines.push('  ' + origen + ': $' + monto.toLocaleString('es-AR'));
      });
    lines.push('  ─────────────────');
    lines.push('  *Total: $' + ayuda.total.toLocaleString('es-AR') + '*');
    lines.push('');
  }

  // Deudas pendientes
  if (deudas.pendientes.length > 0) {
    lines.push('*DEUDAS PENDIENTES*');
    deudas.pendientes
      .sort((a, b) => b.saldo - a.saldo)
      .forEach(d => {
        lines.push('  ' + d.acreedor + ': $' + d.saldo.toLocaleString('es-AR') +
          ' (de $' + d.montoTotal.toLocaleString('es-AR') + ')');
      });
    lines.push('  ─────────────────');
    lines.push('  *Total: $' + deudas.total.toLocaleString('es-AR') + '*');
  }

  return lines.join('\n');
}

// Es el dia 1 del mes a las 9:00 AM?
function isReportTime() {
  const now = new Date();
  return now.getDate() === 1 && now.getHours() === 9 && now.getMinutes() === 0;
}

export function startMonthlyScheduler(getSock, targetJid) {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
  if (!targetJid) {
    logger.warn('WHATSAPP_SUMMARY_JID no configurado, reporte mensual desactivado');
    return;
  }
  logger.info('Scheduler de reporte mensual iniciado');

  schedulerInterval = setInterval(async () => {
    if (!isReportTime()) return;
    logger.info('Generando reporte mensual...');
    try {
      const data = await getReporteMensual(-1);
      const msg  = formatReporteMensual(data);
      const sock = getSock();
      if (!sock) { logger.warn('Socket no disponible para reporte mensual'); return; }
      await sock.sendMessage(targetJid, { text: msg });
      logger.info('Reporte mensual enviado');
    } catch (err) {
      logger.error({ err }, 'Error enviando reporte mensual');
    }
  }, 60 * 1000); // chequear cada minuto
}

export function stopMonthlyScheduler() {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
}
