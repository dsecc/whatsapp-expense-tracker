import { readFileSync, writeFileSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { getCumpleanos } from '../sheets/client.js';

let schedulerInterval = null;
let resetTimer        = null;

// ── Estado persistente ────────────────────────────────────────────────────────
// Formato de key: "id-dias-dd/mm/yyyy" (dias=30|7|1|0)
const NOTIF_STATE_PATH = '/app/data/cumpleanos_notif_state.json';

// Hora AR a partir de la cual salen los avisos previos (1 mes, 1 semana y 1 día antes).
// El del mismo día sale a las 00:01 para saludar a la medianoche.
const HORA_AVISO_PREVIO = 21;

function loadState() {
  try {
    if (!existsSync(NOTIF_STATE_PATH)) return {};
    return JSON.parse(readFileSync(NOTIF_STATE_PATH, 'utf8'));
  } catch { return {}; }
}

function saveState(state) {
  try { writeFileSync(NOTIF_STATE_PATH, JSON.stringify(state), 'utf8'); } catch (e) {
    logger.warn({ e }, 'No se pudo guardar cumpleanos_notif_state.json');
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

// ── Zona horaria AR (Intl explicito) ──────────────────────────────────────────
const TZ_AR = 'America/Argentina/Buenos_Aires';

export function nowAR() {
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

function diasEntre(desde, hasta) {
  const d = new Date(desde); d.setHours(0, 0, 0, 0);
  const h = new Date(hasta); h.setHours(0, 0, 0, 0);
  return Math.round((h - d) / 86400000);
}

function esBisiesto(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// 29/2 en año no bisiesto → se corre al 1/3 (evita que nunca dispare)
function construirFecha(year, mes, dia) {
  if (mes === 2 && dia === 29 && !esBisiesto(year)) return new Date(year, 2, 1);
  return new Date(year, mes - 1, dia);
}

// Proxima ocurrencia del cumpleaños (este año si todavia no paso, si no el que viene)
export function proximaOcurrencia(dia, mes, ar) {
  const esteAnio = construirFecha(ar.year, mes, dia);
  if (diasEntre(ar.dateOnly, esteAnio) >= 0) return esteAnio;
  return construirFecha(ar.year + 1, mes, dia);
}

// ── Reset diario del estado ───────────────────────────────────────────────────
function programarResetDiario() {
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  const ar     = nowAR();
  const mañana = new Date(ar.year, ar.month - 1, ar.day + 1, 0, 0, 30);
  resetTimer   = setTimeout(() => {
    limpiarAntiguo(nowAR().fecha);
    logger.info('Estado notificaciones cumpleanos limpiado a medianoche AR');
    programarResetDiario();
  }, mañana.getTime() - Date.now());
}

// ── Helpers de mensaje ────────────────────────────────────────────────────────
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function nombreDia(fecha) { return DIAS_SEMANA[fecha.getDay()]; }

function armarMensaje(c, dias, ocurrencia) {
  const fechaStr   = String(c.dia).padStart(2, '0') + '/' + String(c.mes).padStart(2, '0');
  const notasSufijo = c.notas ? '\n📝 ' + c.notas : '';

  if (dias === 30) {
    return 'En un mes es el cumpleaños de *' + c.nombre + '* (' + fechaStr + '). Tiempo de ir pensando un regalo.' + notasSufijo;
  }
  if (dias === 7) {
    const dia = nombreDia(ocurrencia);
    return 'El *' + dia + '* que viene es el cumpleaños de *' + c.nombre + '* (' + fechaStr + ').' + notasSufijo;
  }
  const edad = c.anio ? ocurrencia.getFullYear() - c.anio : null;
  const edadStr = edad != null ? ' — cumple *' + edad + '*.' : '.';
  if (dias === 1) {
    return 'Mañana es el cumpleaños de *' + c.nombre + '* (' + fechaStr + ')' + edadStr + ' A las 12 acordate de saludar.' + notasSufijo;
  }
  // dias === 0
  return 'Hoy cumple años *' + c.nombre + '*' + edadStr;
}

// ── Check principal ───────────────────────────────────────────────────────────
async function checkCumpleanos(getSock, targetJid) {
  const sock = getSock();
  if (!sock) return;

  let cumples;
  try {
    cumples = await getCumpleanos();
  } catch (err) {
    logger.error({ err }, 'Error leyendo cumpleanos');
    return;
  }

  const ar = nowAR();

  for (const c of cumples) {
    if (!c.dia || !c.mes) continue;

    const ocurrencia = proximaOcurrencia(c.dia, c.mes, ar);
    const dias = diasEntre(ar.dateOnly, ocurrencia);
    if (dias !== 30 && dias !== 7 && dias !== 1 && dias !== 0) continue;

    // Avisos previos: a la noche (no a la madrugada apenas cambia la fecha)
    if (dias > 0 && ar.hour < HORA_AVISO_PREVIO) continue;

    // Aviso del mismo dia: recien a partir de las 00:01
    if (dias === 0 && ar.hour === 0 && ar.minute < 1) continue;

    const key = c.id + '-' + dias + '-' + ar.fecha;
    if (yaAvisado(key)) continue;

    const msg = armarMensaje(c, dias, ocurrencia);
    try {
      await sock.sendMessage(targetJid, { text: msg });
      marcarAvisado(key);
      logger.info({ nombre: c.nombre, dias }, 'Aviso de cumpleanos enviado');
    } catch (err) {
      logger.error({ err }, 'Error enviando aviso de cumpleanos');
    }
  }
}

// ── Arranque ──────────────────────────────────────────────────────────────────
export function startBirthdaysScheduler(getSock, targetJid) {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
  if (!targetJid) {
    logger.warn('WHATSAPP_SUMMARY_JID no configurado, scheduler de cumpleanos desactivado');
    return;
  }
  logger.info('Scheduler de cumpleanos iniciado');
  programarResetDiario();

  checkCumpleanos(getSock, targetJid);
  schedulerInterval = setInterval(() => checkCumpleanos(getSock, targetJid), 15 * 60 * 1000);
}

export function stopBirthdaysScheduler() {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
}
