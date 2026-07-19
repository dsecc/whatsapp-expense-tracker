import { readFileSync, writeFileSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { getRecordatoriosPendientes, clearRecordatorioSnooze, completarRecordatorio } from '../sheets/client.js';

let schedulerInterval = null;
const NOTIF_STATE_PATH = '/app/data/recordatorios_notif_state.json';

function loadState() {
  try {
    if (!existsSync(NOTIF_STATE_PATH)) return {};
    return JSON.parse(readFileSync(NOTIF_STATE_PATH, 'utf8'));
  } catch { return {}; }
}

function saveState(state) {
  try { writeFileSync(NOTIF_STATE_PATH, JSON.stringify(state), 'utf8'); } catch (e) {
    logger.warn({ e }, 'No se pudo guardar recordatorios_notif_state.json');
  }
}

let notifState = loadState();

function marcarAvisado(key) { notifState[key] = true; saveState(notifState); }
function yaAvisado(key)     { return notifState[key] === true; }

function limpiarAntiguo(fechaHoyStr) {
  const [d, m, y] = fechaHoyStr.split('/').map(Number);
  const hoy = new Date(y, m - 1, d);
  const nuevo = {};
  for (const [key, val] of Object.entries(notifState)) {
    const partes   = key.split('-');
    const fechaKey = partes[partes.length - 1];
    const [kd, km, ky] = fechaKey.split('/').map(Number);
    if (isNaN(kd)) { nuevo[key] = val; continue; }
    if ((hoy - new Date(ky, km - 1, kd)) / 86400000 <= 14) nuevo[key] = val;
  }
  notifState = nuevo;
  saveState(notifState);
}

const TZ_AR = 'America/Argentina/Buenos_Aires';

function nowAR() {
  const fmt = new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ_AR,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    day:      parseInt(parts.day),
    month:    parseInt(parts.month),
    year:     parseInt(parts.year),
    hour:     parseInt(parts.hour),
    minute:   parseInt(parts.minute),
    fecha:    parts.day + '/' + parts.month + '/' + parts.year,
    dateOnly: new Date(parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day)),
  };
}

function parseFecha(str) {
  if (!str) return null;
  const [d, m, y] = str.trim().split('/').map(Number);
  if (isNaN(d) || isNaN(m) || isNaN(y)) return null;
  return new Date(y, m - 1, d);
}

let resetTimer = null;
function programarResetDiario() {
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  const ar     = nowAR();
  const mañana = new Date(ar.year, ar.month - 1, ar.day + 1, 0, 0, 30);
  resetTimer   = setTimeout(() => {
    limpiarAntiguo(nowAR().fecha);
    logger.info('Estado notificaciones recordatorios limpiado a medianoche AR');
    programarResetDiario();
  }, mañana.getTime() - Date.now());
}

async function checkRecordatorios(getSock, targetJid) {
  const sock = getSock();
  if (!sock) return;

  let recordatorios;
  try {
    recordatorios = await getRecordatoriosPendientes();
  } catch (err) {
    logger.error({ err }, 'Error leyendo recordatorios');
    return;
  }

  const ar  = nowAR();
  const now = new Date();

  for (const r of recordatorios) {

    // ── Snooze activo ─────────────────────────────────────────────────────────
    if (r.snoozeHasta) {
      const snoozeDate = new Date(r.snoozeHasta);
      if (isNaN(snoozeDate.getTime())) {
        await clearRecordatorioSnooze(r.id).catch(() => {});
      } else if (now < snoozeDate) {
        continue;
      } else {
        await clearRecordatorioSnooze(r.id).catch(() => {});
        const msg = 'Acordate: *' + r.descripcion + '*';
        try {
          await sock.sendMessage(targetJid, { text: msg });
          await completarRecordatorio(r.id, null).catch(() => {});
          logger.info({ id: r.id }, 'Recordatorio post-snooze enviado');
        } catch (err) {
          logger.error({ err }, 'Error enviando recordatorio post-snooze');
        }
        continue;
      }
    }

    // ── Aviso en la fecha/hora configurada ────────────────────────────────────
    const fechaR = parseFecha(r.fecha);
    if (!fechaR) continue;

    const diasDiff = Math.round((ar.dateOnly - fechaR) / 86400000);
    if (diasDiff !== 0) continue;

    const horaAviso = r.hora ? parseInt(r.hora.split(':')[0]) : 8;
    const minAviso  = r.hora ? parseInt(r.hora.split(':')[1] || 0) : 0;
    if (ar.hour < horaAviso || (ar.hour === horaAviso && ar.minute < minAviso)) continue;

    const key = r.id + '-' + ar.fecha;
    if (yaAvisado(key)) continue;

    const horaStr = r.hora ? ' a las *' + r.hora + '*' : '';
    const msg = 'Acordate' + horaStr + ': *' + r.descripcion + '*';
    try {
      await sock.sendMessage(targetJid, { text: msg });
      marcarAvisado(key);
      await completarRecordatorio(r.id, null).catch(() => {});
      logger.info({ id: r.id }, 'Recordatorio enviado');
    } catch (err) {
      logger.error({ err }, 'Error enviando recordatorio');
    }
  }
}

export function startRemindersScheduler(getSock, targetJid) {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
  if (!targetJid) {
    logger.warn('WHATSAPP_SUMMARY_JID no configurado, scheduler de recordatorios desactivado');
    return;
  }
  logger.info('Scheduler de recordatorios iniciado');
  programarResetDiario();

  checkRecordatorios(getSock, targetJid);
  schedulerInterval = setInterval(() => checkRecordatorios(getSock, targetJid), 15 * 60 * 1000);
}

export function stopRemindersScheduler() {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
}
