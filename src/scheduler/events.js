import { readFileSync, writeFileSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { getEventosFuturos } from '../sheets/client.js';

let schedulerInterval = null;
let resetTimer        = null;

// ── Estado persistente ────────────────────────────────────────────────────────
// Formato de key: "id-dias-dd/mm/yyyy"
// dias=3 → aviso 3 días antes | dias=1 → aviso 1 día antes | dias=0 → aviso mismo día (8AM+)
const NOTIF_STATE_PATH = '/app/data/eventos_notif_state.json';

function loadState() {
  try {
    if (!existsSync(NOTIF_STATE_PATH)) return {};
    return JSON.parse(readFileSync(NOTIF_STATE_PATH, 'utf8'));
  } catch { return {}; }
}

function saveState(state) {
  try { writeFileSync(NOTIF_STATE_PATH, JSON.stringify(state), 'utf8'); } catch (e) {
    logger.warn({ e }, 'No se pudo guardar eventos_notif_state.json');
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
    if ((hoy - new Date(ky, km - 1, kd)) / 86400000 <= 7) nuevo[key] = val;
  }
  notifState = nuevo;
  saveState(notifState);
}

// ── Zona horaria AR (Intl explícito, no depende del TZ env del container) ─────
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

function diasEntre(desde, hasta) {
  const d = new Date(desde); d.setHours(0, 0, 0, 0);
  const h = new Date(hasta); h.setHours(0, 0, 0, 0);
  return Math.round((h - d) / 86400000);
}

// ── Reset de estado a medianoche (un solo timer activo) ───────────────────────
function programarResetDiario() {
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  const ar     = nowAR();
  const mañana = new Date(ar.year, ar.month - 1, ar.day + 1, 0, 0, 30);
  resetTimer   = setTimeout(() => {
    limpiarAntiguo(nowAR().fecha);
    logger.info('Estado notificaciones eventos limpiado a medianoche AR');
    programarResetDiario();
  }, mañana.getTime() - Date.now());
}

// ── Helpers de mensaje ────────────────────────────────────────────────────────

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function nombreDia(fecha) {
  return DIAS_SEMANA[fecha.getDay()];
}

// Cierres opcionales por tipo. Se eligen al azar y solo se usan ~25% de las veces.
const CIERRES = {
  turno:        ['Ojalá que todo vaya bien.', 'Que no haya sala de espera eterna.', 'Suerte con el turno.'],
  reunion:      ['A darle.', 'Que fluya.', 'Suerte, aunque seguro no la necesitás.'],
  evento:       ['Que la pases bien.', 'Va a estar bueno.', 'Disfrutalo.'],
  examen:       ['Mucho ánimo.', 'Ya estudiaste, tranquilo.', 'A darle con todo.'],
  social:       ['Que la pases bien.', 'Divertite.', 'Mejor que la última vez, seguro.'],
  pago:         ['No se te olvide la billetera.', 'Que no duela mucho.'],
  recordatorio: ['Anotado.', 'Ahí lo tenés.'],
};
const CIERRES_GENERICO = ['Que salga bien.', 'Éxitos.', 'Buena suerte.'];

function cierreOpcional(tipo) {
  if (Math.random() > 0.25) return '';
  const opts = CIERRES[tipo?.toLowerCase()] || CIERRES_GENERICO;
  return ' ' + opts[Math.floor(Math.random() * opts.length)];
}

function armarMensaje(evento, dias, fechaEvento) {
  const horaStr = evento.hora ? ' a las *' + evento.hora + '*' : '';
  const cierre  = cierreOpcional(evento.tipo);

  if (dias === 3) {
    const dia = nombreDia(fechaEvento);
    return 'Che, el *' + dia + '* tenés *' + evento.descripcion + '*' + horaStr + '.' + cierre;
  }
  if (dias === 1) {
    return 'Mañana tenés *' + evento.descripcion + '*' + horaStr + '.' + cierre;
  }
  // días === 0
  const cuandoStr = evento.hora ? 'hoy' + horaStr : 'hoy';
  return 'Acordate que ' + cuandoStr + ' tenés *' + evento.descripcion + '*.' + cierre;
}

// ── Check principal ───────────────────────────────────────────────────────────

async function checkEventos(getSock, targetJid) {
  const sock = getSock();
  if (!sock) return;

  let eventos;
  try {
    eventos = await getEventosFuturos();
  } catch (err) {
    logger.error({ err }, 'Error leyendo eventos');
    return;
  }

  const ar = nowAR();

  for (const evento of eventos) {
    const fechaEvento = parseFecha(evento.fecha);
    if (!fechaEvento) continue;

    const dias = diasEntre(ar.dateOnly, fechaEvento);

    // Aviso 3 días antes y 1 día antes → sin restricción horaria
    if (dias === 3 || dias === 1) {
      const key = evento.id + '-' + dias + '-' + ar.fecha;
      if (yaAvisado(key)) continue;

      const msg = armarMensaje(evento, dias, fechaEvento);

      try {
        await sock.sendMessage(targetJid, { text: msg });
        marcarAvisado(key);
        logger.info({ evento: evento.descripcion, dias }, 'Aviso de evento enviado');
      } catch (err) {
        logger.error({ err }, 'Error enviando aviso de evento');
      }
      continue;
    }

    // Aviso el mismo día → a partir de la hora configurada en el evento (default 8:00 AR)
    const avisoHoraStr = evento.avisoHora || '08:00';
    const avisoHora     = parseInt(avisoHoraStr.split(':')[0], 10);
    if (dias === 0 && ar.hour >= (isNaN(avisoHora) ? 8 : avisoHora)) {
      const key = evento.id + '-0-' + ar.fecha;
      if (yaAvisado(key)) continue;

      const msg = armarMensaje(evento, 0, fechaEvento);

      try {
        await sock.sendMessage(targetJid, { text: msg });
        marcarAvisado(key);
        logger.info({ evento: evento.descripcion }, 'Aviso mismo-dia enviado');
      } catch (err) {
        logger.error({ err }, 'Error enviando aviso mismo-dia');
      }
    }
  }
}

// ── Arranque ──────────────────────────────────────────────────────────────────

export function startEventsScheduler(getSock, targetJid) {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
  if (!targetJid) {
    logger.warn('WHATSAPP_SUMMARY_JID no configurado, scheduler de eventos desactivado');
    return;
  }
  logger.info('Scheduler de eventos iniciado');
  programarResetDiario();

  checkEventos(getSock, targetJid);
  schedulerInterval = setInterval(() => checkEventos(getSock, targetJid), 60 * 60 * 1000);
}

export function stopEventsScheduler() {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
}
