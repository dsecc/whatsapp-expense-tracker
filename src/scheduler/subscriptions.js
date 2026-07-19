import { readFileSync, writeFileSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { getSuscripcionesActivas, clearSnooze } from '../sheets/client.js';

const MAX_SNOOZE  = 2;
const SNOOZE_HOURS = 3;
let schedulerInterval  = null;
let resetTimer         = null;   // un solo timer de reset activo a la vez

// ── Estado persistente ────────────────────────────────────────────────────────
// Guardamos en /app/data/notif_state.json para sobrevivir reinicios del container.
// Formato: { "subId-dd/mm/yyyy": true, ... }
const NOTIF_STATE_PATH = '/app/data/notif_state.json';

function loadNotifState() {
  try {
    if (!existsSync(NOTIF_STATE_PATH)) return {};
    return JSON.parse(readFileSync(NOTIF_STATE_PATH, 'utf8'));
  } catch { return {}; }
}

function saveNotifState(state) {
  try { writeFileSync(NOTIF_STATE_PATH, JSON.stringify(state), 'utf8'); } catch (e) {
    logger.warn({ e }, 'No se pudo guardar notif_state.json');
  }
}

// Carga inicial; se mantiene en memoria durante la ejecucion
let notifState = loadNotifState();

function marcarAvisado(key) {
  notifState[key] = true;
  saveNotifState(notifState);
}

function yaAvisado(key) {
  return notifState[key] === true;
}

// Limpia entradas de más de 7 días para que el archivo no crezca indefinidamente
function limpiarNotifStateAntiguo(fechaHoyStr) {
  const [d, m, y] = fechaHoyStr.split('/').map(Number);
  const hoy = new Date(y, m - 1, d);
  const nuevaState = {};
  for (const [key, val] of Object.entries(notifState)) {
    // key tiene formato "subId-dd/mm/yyyy"
    const partes = key.split('-');
    if (partes.length < 2) continue;
    const fechaKey = partes[partes.length - 1];
    const [kd, km, ky] = fechaKey.split('/').map(Number);
    if (isNaN(kd)) { nuevaState[key] = val; continue; }
    const keyDate = new Date(ky, km - 1, kd);
    if ((hoy - keyDate) / 86400000 <= 7) nuevaState[key] = val;
  }
  notifState = nuevaState;
  saveNotifState(notifState);
}

// ── Helpers de fecha (usando Intl para zona AR explícita) ─────────────────────
const TZ_AR = 'America/Argentina/Buenos_Aires';

function nowAR() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ_AR,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return {
    day:    parseInt(parts.day),
    month:  parseInt(parts.month),
    year:   parseInt(parts.year),
    hour:   parseInt(parts.hour),
    minute: parseInt(parts.minute),
    fecha:  parts.day + '/' + parts.month + '/' + parts.year,
    dateOnly: new Date(parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day)),
  };
}

// Dias que faltan entre dos objetos Date (comparando solo el dia, sin hora)
function diasEntre(desde, hasta) {
  const d = new Date(desde); d.setHours(0, 0, 0, 0);
  const h = new Date(hasta); h.setHours(0, 0, 0, 0);
  return Math.round((h - d) / 86400000);
}

// Proximo vencimiento de una suscripcion paga dado el dia del mes.
// Compara por numero de dia en AR para no perder el "mismo dia".
function proximoVencimientoPaga(diaSub) {
  const ar  = nowAR();
  const mes = ar.month - 1; // 0-indexed para Date
  // Si hoy es anterior o igual al dia de vencimiento → vence este mes
  // Si hoy ya paso ese dia → vence el mes siguiente
  if (ar.day <= diaSub) {
    return new Date(ar.year, mes, diaSub);
  }
  return new Date(ar.year, mes + 1, diaSub);
}

// Parsea "dd/mm/yyyy" a Date (medianoche local)
function parseFecha(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.trim().split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  if (isNaN(d) || isNaN(m) || isNaN(y)) return null;
  return new Date(y, m - 1, d);
}

// ── Reset diario del estado ───────────────────────────────────────────────────
// Un solo timer activo a la vez; se reprograma al disparar.
function programarResetDiario() {
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  const ar = nowAR();
  const mañana = new Date(ar.year, ar.month - 1, ar.day + 1, 0, 0, 30);
  const ms = mañana.getTime() - Date.now();
  resetTimer = setTimeout(() => {
    limpiarNotifStateAntiguo(nowAR().fecha);
    logger.info('Estado de notificaciones limpiado a medianoche AR');
    programarResetDiario();
  }, ms);
}

// ── Check principal ───────────────────────────────────────────────────────────

async function checkSuscripciones(getSock, targetJid) {
  const sock = getSock();
  if (!sock) return;

  let subs;
  try {
    subs = await getSuscripcionesActivas();
  } catch (err) {
    logger.error({ err }, 'Error leyendo suscripciones');
    return;
  }

  const ar  = nowAR();
  const now = new Date();

  for (const sub of subs) {

    // ── Snooze activo ──────────────────────────────────────────────────────────
    if (sub.snoozeHasta) {
      const snoozeDate = new Date(sub.snoozeHasta);
      // Ignorar valores invalidos en la celda (no bloquear la sub para siempre)
      if (isNaN(snoozeDate.getTime())) {
        logger.warn({ sub: sub.nombre, snoozeHasta: sub.snoozeHasta }, 'snoozeHasta invalido, ignorando');
        await clearSnooze(sub.id).catch(() => {});
        // No hacer continue: seguimos con el check normal
      } else if (now < snoozeDate) {
        // Snooze todavia activo → saltear
        continue;
      } else {
        // Snooze vencido → avisar y limpiar, luego seguir con el check normal
        await clearSnooze(sub.id).catch(() => {});
        const esUltimo = sub.snoozeCount >= MAX_SNOOZE;
        const msgSnooze = esUltimo
          ? 'Ultimo aviso (no puedo recordarte mas): *' + sub.nombre + '* vence pronto. Cancelala o va a renovarse.'
          : 'Recordatorio: *' + sub.nombre + '* vence pronto. Respondé "snooze ' + sub.nombre + '" para recordarte en ' + SNOOZE_HOURS + 'hs más.';
        try {
          await sock.sendMessage(targetJid, { text: msgSnooze });
          logger.info({ sub: sub.nombre }, 'Aviso post-snooze enviado');
        } catch (err) {
          logger.error({ err }, 'Error enviando aviso post-snooze');
        }
        continue; // ya se mando el aviso de snooze, no duplicar con el normal
      }
    }

    // ── Calcular dias hasta vencimiento ──────────────────────────────────────
    let fechaVence = null;
    const esPrueba = sub.tipo === 'prueba';

    if (esPrueba) {
      fechaVence = parseFecha(sub.fechaFinPrueba);
      if (!fechaVence) continue;
    } else {
      if (!sub.dia || sub.dia <= 0) continue;
      fechaVence = proximoVencimientoPaga(sub.dia);
    }

    const dias = diasEntre(ar.dateOnly, fechaVence);

    // Avisar a 3 dias, 1 dia y el mismo dia (0)
    if (dias !== 3 && dias !== 1 && dias !== 0) continue;

    // No repetir si ya se aviso hoy para este tramo
    const key = sub.id + '-' + dias + '-' + ar.fecha;
    if (yaAvisado(key)) continue;

    // ── Armar mensaje ─────────────────────────────────────────────────────────
    const fechaStr = fechaVence.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const divisaSub = (sub.divisa || 'ARS').toUpperCase();
    const signo     = divisaSub === 'USD' ? 'U$S ' : '$';
    let cuandoStr;
    if (dias === 0)      cuandoStr = '*hoy*';
    else if (dias === 1) cuandoStr = '*mañana* (' + fechaStr + ')';
    else                 cuandoStr = 'en *3 días* (' + fechaStr + ')';

    let msg;
    if (esPrueba) {
      msg = 'Ojo: la prueba gratis de *' + sub.nombre + '* vence ' + cuandoStr + '.\n' +
        'Cancelala antes o empieza a pagar.\n\n' +
        (dias > 0 ? 'Respondé "snooze ' + sub.nombre + '" para que te recuerde en ' + SNOOZE_HOURS + 'hs.' : '');
    } else {
      msg = 'Recordatorio: *' + sub.nombre + '* se renueva ' + cuandoStr + ' — ' + signo + sub.monto.toLocaleString('es-AR') + '.\n\n' +
        (dias > 0 ? 'Respondé "snooze ' + sub.nombre + '" para que te recuerde en ' + SNOOZE_HOURS + 'hs.' : '');
    }

    try {
      await sock.sendMessage(targetJid, { text: msg.trim() });
      marcarAvisado(key);
      logger.info({ sub: sub.nombre, dias }, 'Aviso de suscripcion enviado');
    } catch (err) {
      logger.error({ err }, 'Error enviando aviso de suscripcion');
    }
  }
}

// ── Arranque ──────────────────────────────────────────────────────────────────

export function startSubscriptionScheduler(getSock, targetJid) {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
  if (!targetJid) {
    logger.warn('WHATSAPP_SUMMARY_JID no configurado, scheduler de suscripciones desactivado');
    return;
  }
  logger.info('Scheduler de suscripciones iniciado');
  programarResetDiario();

  checkSuscripciones(getSock, targetJid);
  schedulerInterval = setInterval(() => checkSuscripciones(getSock, targetJid), 60 * 60 * 1000);
}

export function stopSubscriptionScheduler() {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
}

export { SNOOZE_HOURS, MAX_SNOOZE };
