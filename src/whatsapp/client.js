import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  extractMessageContent,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { processMessage, necesitaRecordatorios } from '../ai/claude.js';
import {
  appendExpense, ensureHeaders,
  findRowById, findRowsByIds,
  updateRow, deleteRow,
  getRecentRows,
  getCategoryBreakdownByPeriod, getAyudaByPeriod,
  nombreMesAnio, getReporteMensual,
  appendAyuda,
  appendDeuda, pagarDeuda, sumarDeuda, buscarDeudasPorAcreedor, getResumenDeudas, borrarTodasDeudas, borrarDeudasSaldadas,
  appendSuscripcion, getSuscripcionesActivas, cancelarSuscripcion, editarSuscripcion, eliminarSuscripcion, updateSnooze,
  applyMonthFormatting,
  appendEvento, getEventosFuturos, eliminarEvento, editarEvento, ensureEventosHeaders,
  appendArchivo, buscarArchivos, getArchivos, ensureArchivosHeaders,
  appendRecordatorio, getRecordatoriosPendientes, snoozeRecordatorio,
  eliminarRecordatorio, ensureRecordatoriosHeaders,
} from '../sheets/client.js';
import {
  setPendingAction, getPendingAction, clearPendingAction, hasPendingAction,
  pushHistory, getHistory,
  pushInteracted, getLastInteracted, getInteractedStack, popInteracted, setLastInteracted,
  setPendingMedia, getPendingMedia, clearPendingMedia,
} from '../state/conversation.js';
import { startWeeklyScheduler } from '../scheduler/weekly.js';
import { startSubscriptionScheduler, SNOOZE_HOURS, MAX_SNOOZE } from '../scheduler/subscriptions.js';
import { startMonthlyScheduler, formatReporteMensual } from '../scheduler/monthly.js';
import { startEventsScheduler } from '../scheduler/events.js';
import { startRemindersScheduler } from '../scheduler/reminders.js';
import { transcribeAudio } from './transcribe.js';

let sock = null;
const getSock = () => sock;

async function ensureSessionDir() {
  if (!existsSync(config.whatsapp.sessionDir)) {
    await mkdir(config.whatsapp.sessionDir, { recursive: true });
  }
}

async function ensureFilesDir() {
  if (!existsSync(config.files.dir)) {
    await mkdir(config.files.dir, { recursive: true });
  }
}

// ── Helpers de archivos (imagenes/PDF guardados) ─────────────────────────────

const MIME_TO_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };
const EXT_TO_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };

function extFromMediaType(mediaType) {
  return MIME_TO_EXT[mediaType] || '.bin';
}

function mimeFromArchivo(archivo) {
  return EXT_TO_MIME[path.extname(archivo).toLowerCase()] || 'application/octet-stream';
}

// ── Helpers de formato ───────────────────────────────────────────────────────

function formatRow(r) {
  const monto = parseFloat(r.monto) || 0;
  return '*#' + r.id + '* | ' + r.fecha + ' | ' + r.tipo +
    ' | *$' + monto.toLocaleString('es-AR') + '* | ' + r.categoria + ' | ' + r.detalle;
}

function formatDeuda(d) {
  const divisa = (d.divisa || 'ARS').toUpperCase();
  const signo  = divisa === 'USD' ? 'U$S ' : '$';
  return '*#' + d.id + '* | ' + d.acreedor + ' | ' + signo + d.saldo.toLocaleString('es-AR') + ' ' + divisa + ' | Total: ' + signo + d.montoTotal.toLocaleString('es-AR');
}

// ── Formatear resumen detallado (gastos + ayuda) ─────────────────────────────

async function buildResumenDetallado(periodo, opciones = {}) {
  const { tipoCambio, mesNumero, anio, fechaEspecifica } = opciones;

  // Ajuste de año para mes especifico futuro
  let anioFinal = anio;
  if ((periodo === 'mes_especifico') && mesNumero != null && anio != null) {
    const ar = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    const mesActual = ar.getMonth() + 1;
    const anioActual = ar.getFullYear();
    if (anio === anioActual && mesNumero > mesActual) anioFinal = anioActual - 1;
  }

  const opsFinal = { mesNumero, anio: anioFinal, fechaEspecifica };

  const [breakdown, ayuda] = await Promise.all([
    getCategoryBreakdownByPeriod(periodo, opsFinal),
    getAyudaByPeriod(periodo, opsFinal),
  ]);

  // Label del periodo
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  let label;
  if (periodo === 'mes_especifico') label = nombreMesAnio(mesNumero, anioFinal);
  else if (periodo === 'dia_semana') label = fechaEspecifica || 'ese día';
  else {
    const labels = {
      hoy: 'hoy', ayer: 'ayer', anteayer: 'anteayer',
      semana: 'esta semana',
      mes: nombreMesAnio(now.getMonth() + 1, now.getFullYear()),
    };
    label = labels[periodo] || periodo;
  }

  if (breakdown.count === 0 && ayuda.count === 0) {
    return 'No hay registros para ' + label + '.';
  }

  const lines = ['*Resumen de ' + label + '* 📊', ''];

  if (breakdown.count > 0) {
    if (breakdown.totalARS > 0) {
      lines.push('*Gastos en pesos:*');
      Object.entries(breakdown.breakdownARS)
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a)
        .forEach(([cat, m]) => lines.push('  ' + cat.charAt(0).toUpperCase() + cat.slice(1) + ': $' + m.toLocaleString('es-AR')));
      lines.push('  *Total ARS: $' + breakdown.totalARS.toLocaleString('es-AR') + '*');
      lines.push('');
    }
    if (breakdown.totalUSD > 0) {
      lines.push('*Gastos en dólares:*');
      Object.entries(breakdown.breakdownUSD)
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a)
        .forEach(([cat, m]) => lines.push('  ' + cat.charAt(0).toUpperCase() + cat.slice(1) + ': U$S ' + m.toLocaleString('es-AR')));
      lines.push('  *Total USD: U$S ' + breakdown.totalUSD.toLocaleString('es-AR') + '*');
      if (tipoCambio) lines.push('  (= $' + (breakdown.totalUSD * tipoCambio).toLocaleString('es-AR') + ' al cambio de $' + tipoCambio.toLocaleString('es-AR') + ')');
      lines.push('');
    }
  } else {
    lines.push('Sin gastos registrados en ' + label + '.');
    lines.push('');
  }

  if (ayuda.count > 0) {
    lines.push('*Ayuda recibida:*');
    Object.entries(ayuda.porOrigen)
      .sort(([, a], [, b]) => b - a)
      .forEach(([origen, monto]) => lines.push('  ' + origen + ': $' + monto.toLocaleString('es-AR')));
    lines.push('  *Total ayuda: $' + ayuda.total.toLocaleString('es-AR') + '*');
  }

  return lines.join('\n');
}

// ── Resolver fila desde tool input ───────────────────────────────────────────

async function resolveRow(from, input, recentRows) {
  const stack = getInteractedStack(from);

  // Por stack (ultimo, anterior, etc.)
  if (input.usar_ultimo) {
    const idx = input.indice_stack ?? 0;
    const reversed = stack.slice().reverse();
    if (reversed[idx]) {
      const entry = reversed[idx];
      if (entry.rowIndex != null) return entry;
      return await findRowById(entry.rowObject.id);
    }
  }

  // Por ID exacto
  if (input.id_referenciado != null) {
    return await findRowById(input.id_referenciado);
  }

  // Por busqueda semantica en filas recientes (simple matching por descripcion)
  if (input.descripcion_busqueda) {
    const needle = input.descripcion_busqueda.toLowerCase();
    for (let i = recentRows.length - 1; i >= 0; i--) {
      const r = recentRows[i];
      if (r.detalle?.toLowerCase().includes(needle) || r.categoria?.toLowerCase().includes(needle)) {
        return await findRowById(r.id);
      }
    }
  }

  return null;
}

// ── Dispatcher de herramientas ───────────────────────────────────────────────

async function executeTool(from, toolName, input, recentRows, isAudio = false) {
  logger.info({ toolName, input }, 'Ejecutando herramienta');

  switch (toolName) {

    // ── Registrar gasto/ingreso ──────────────────────────────────────────────
    case 'registrar_gasto_ingreso': {
      const id    = await appendExpense({ tipo: input.tipo, monto: input.monto, categoria: input.categoria, descripcion: input.descripcion, confianza: 'alta', divisa: input.divisa || 'ARS' });
      const esGasto = input.tipo === 'gasto';
      const signo = esGasto ? '-' : '+';
      const reply = '*[' + input.tipo.toUpperCase() + ' REGISTRADO — #' + id + ']*\n\n' +
        'Monto: $' + signo + (input.monto || 0).toLocaleString('es-AR') + '\n' +
        'Categoría: ' + input.categoria + '\n' +
        'Detalle: ' + input.descripcion;
      setLastInteracted(from, { id, tipo: input.tipo, monto: input.monto, categoria: input.categoria, detalle: input.descripcion, fecha: new Date().toLocaleDateString('es-AR') }, null);
      return reply;
    }

    // ── Editar gasto ─────────────────────────────────────────────────────────
    case 'editar_gasto': {
      const found = await resolveRow(from, input, recentRows);
      if (!found) return 'No encontré el gasto que querés editar. Dame el número (#ID) o describilo mejor.';

      const newData = {
        monto:       input.es_mitad ? parseFloat(found.rowObject.monto) / 2 : (input.nuevo_monto ?? null),
        categoria:   input.nueva_categoria   ?? null,
        descripcion: input.nueva_descripcion ?? null,
        tipo:        input.nuevo_tipo        ?? null,
      };
      const hasChanges = Object.values(newData).some(v => v != null);
      if (!hasChanges) return 'Encontré el gasto pero no entendí qué querés cambiar.';

      const lines = [];
      if (newData.monto      != null) lines.push('Monto: $' + parseFloat(found.rowObject.monto).toLocaleString('es-AR') + ' → *$' + parseFloat(newData.monto).toLocaleString('es-AR') + '*');
      if (newData.categoria  != null) lines.push('Categoría: ' + found.rowObject.categoria + ' → *' + newData.categoria + '*');
      if (newData.descripcion!= null) lines.push('Detalle: ' + found.rowObject.detalle + ' → *' + newData.descripcion + '*');
      if (newData.tipo       != null) lines.push('Tipo: ' + found.rowObject.tipo + ' → *' + newData.tipo + '*');

      if (isAudio) {
        // En audio se aplica directo sin confirmacion
        const updated = await updateRow(found.rowIndex, found.rowObject, newData);
        pushInteracted(from, { rowObject: { ...found.rowObject, ...updated, id: found.rowObject.id }, rowIndex: found.rowIndex });
        return '*#' + found.rowObject.id + ' actualizado:*\n' + lines.join('\n');
      }

      setPendingAction(from, { tipo: 'update', rowIndex: found.rowIndex, rowObject: found.rowObject, newData });
      return 'Encontré este gasto:\n' + formatRow(found.rowObject) + '\n\nCambios a aplicar:\n' + lines.join('\n') + '\n\n¿Confirmás?';
    }

    // ── Eliminar gasto ───────────────────────────────────────────────────────
    case 'eliminar_gasto': {
      // Multiples IDs
      if (input.ids_referenciados && input.ids_referenciados.length > 1) {
        const found    = await findRowsByIds(input.ids_referenciados);
        const foundIds = new Set(found.map(f => parseInt(f.rowObject.id)));
        const notFound = input.ids_referenciados.filter(id => !foundIds.has(parseInt(id)));
        if (found.length === 0) return 'No encontré ningún gasto con esos IDs.';
        const lista = found.slice().sort((a, b) => parseInt(a.rowObject.id) - parseInt(b.rowObject.id)).map(f => formatRow(f.rowObject)).join('\n');
        setPendingAction(from, { tipo: 'delete_multiple', rows: found });
        let reply = 'Vas a eliminar ' + found.length + ' gasto(s):\n\n' + lista + '\n\n';
        if (notFound.length > 0) reply += '_(IDs no encontrados: ' + notFound.join(', ') + ')_\n\n';
        return reply + '¿Confirmás?';
      }

      const found = await resolveRow(from, input, recentRows);
      if (!found) return 'No encontré el gasto que querés eliminar. Dame el número (#ID) o describilo mejor.';
      setPendingAction(from, { tipo: 'delete', rowIndex: found.rowIndex, rowObject: found.rowObject });
      return 'Vas a eliminar este gasto:\n' + formatRow(found.rowObject) + '\n\n¿Confirmás?';
    }

    // ── Ver resumen detallado ────────────────────────────────────────────────
    case 'ver_resumen': {
      const msg = await buildResumenDetallado(input.periodo, {
        tipoCambio:      input.tipo_cambio    || null,
        mesNumero:       input.mes_numero     || null,
        anio:            input.anio           || null,
        fechaEspecifica: input.fecha_especifica || null,
      });
      return msg;
    }

    // ── Ayuda ────────────────────────────────────────────────────────────────
    case 'registrar_ayuda': {
      const id = await appendAyuda({ monto: input.monto, deQuien: input.de_quien, descripcion: input.descripcion, divisa: input.divisa || 'ARS' });
      const divisa = (input.divisa || 'ARS').toUpperCase();
      const signo  = divisa === 'USD' ? 'U$S ' : '$';
      return '*[AYUDA REGISTRADA — #' + id + ']*\n\nAnotado.\nDe: ' + input.de_quien + '\nMonto: +' + signo + (input.monto || 0).toLocaleString('es-AR') + (divisa === 'USD' ? ' USD' : '');
    }

    case 'ver_resumen_ayuda': {
      const ar  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      const msg = await buildResumenDetallado('mes', { mesNumero: ar.getMonth() + 1, anio: ar.getFullYear() });
      return msg;
    }

    // ── Deudas ───────────────────────────────────────────────────────────────
    case 'registrar_deuda': {
      const deudas = await buscarDeudasPorAcreedor(input.acreedor);
      if (deudas.length > 0) {
        const lista = deudas.map(d => formatDeuda(d)).join('\n');
        const divisa = (input.divisa || 'ARS').toUpperCase();
        const signo  = divisa === 'USD' ? 'U$S ' : '$';
        setPendingAction(from, { tipo: 'deuda_nueva_o_suma', parsedDeuda: { acreedor: input.acreedor, montoTotal: input.monto, descripcion: input.descripcion, divisa: input.divisa }, deudas });
        return 'Ya tenés deudas pendientes con *' + input.acreedor + '*:\n\n' + lista + '\n\n¿Registrás una deuda *nueva* (' + signo + input.monto.toLocaleString('es-AR') + ' ' + divisa + ') o la *sumás* a una existente?\nRespondé: *nueva*, o el *#ID* al que sumar (ej: #3)';
      }
      const result = await appendDeuda({ acreedor: input.acreedor, montoTotal: input.monto, descripcion: input.descripcion, divisa: input.divisa || 'ARS' });
      const divisa = (input.divisa || 'ARS').toUpperCase();
      const signo  = divisa === 'USD' ? 'U$S ' : '$';
      return '*[DEUDA REGISTRADA - #' + result.id + ']*\n\nAnotado.\nAcreedor: ' + result.acreedor + '\nMonto: ' + signo + result.montoTotal.toLocaleString('es-AR') + '\nSaldo pendiente: ' + signo + result.saldo.toLocaleString('es-AR');
    }

    case 'sumar_deuda': {
      const deudas = await buscarDeudasPorAcreedor(input.acreedor);
      if (deudas.length === 0) return 'No encontré ninguna deuda pendiente con ' + input.acreedor + '.';
      if (deudas.length > 1) {
        const lista = deudas.map(d => formatDeuda(d)).join('\n');
        setPendingAction(from, { tipo: 'elegir_deuda_suma', montoAdicional: input.monto_adicional, divisa: input.divisa });
        return 'Tenés varias deudas con ' + input.acreedor + ':\n\n' + lista + '\n\nIndicá el *#ID* al que sumar $' + input.monto_adicional.toLocaleString('es-AR') + ':';
      }
      const result = await sumarDeuda(deudas[0].id, input.monto_adicional);
      const divisa = (result.divisa || 'ARS').toUpperCase();
      const signo  = divisa === 'USD' ? 'U$S ' : '$';
      return '*[DEUDA ACTUALIZADA - #' + result.id + ']*\n\nNuevo total: ' + signo + result.montoTotal.toLocaleString('es-AR') + '\nSaldo: ' + signo + result.saldo.toLocaleString('es-AR');
    }

    case 'pagar_deuda': {
      const deudas = await buscarDeudasPorAcreedor(input.acreedor);
      if (deudas.length === 0) return 'No encontré ninguna deuda pendiente con ' + input.acreedor + '.';
      if (deudas.length > 1) {
        const lista = deudas.map(d => formatDeuda(d)).join('\n');
        setPendingAction(from, { tipo: 'elegir_deuda_pago', montoPago: input.monto_pago });
        return 'Tenés ' + deudas.length + ' deudas con ' + input.acreedor + ':\n\n' + lista + '\n\nIndicá el *#ID* al que aplicar el pago de $' + input.monto_pago.toLocaleString('es-AR') + ':';
      }
      const result = await pagarDeuda(deudas[0].id, input.monto_pago);
      const divisa = (result.divisa || 'ARS').toUpperCase();
      const signo  = divisa === 'USD' ? 'U$S ' : '$';
      const lines  = ['*[PAGO REGISTRADO]*', '', 'Anotado.', 'Acreedor: ' + result.acreedor, 'Pago: ' + signo + input.monto_pago.toLocaleString('es-AR')];
      if (result.estado === 'saldada') lines.push('Estado: *DEUDA SALDADA*');
      else lines.push('Saldo restante: ' + signo + result.saldo.toLocaleString('es-AR'));
      return lines.join('\n');
    }

    case 'ver_resumen_deudas': {
      const { pendientes, total } = await getResumenDeudas();
      if (pendientes.length === 0) return 'No tenés deudas pendientes.';
      const lineas = pendientes.sort((a, b) => b.saldo - a.saldo)
        .map(d => '  ' + d.acreedor + ': $' + d.saldo.toLocaleString('es-AR') + ' (de $' + d.montoTotal.toLocaleString('es-AR') + ')');
      return ['*Deudas pendientes* 📋', ''].concat(lineas).concat(['', '*Total: $' + total.toLocaleString('es-AR') + '*']).join('\n');
    }

    case 'borrar_deudas_saldadas': {
      const count = await borrarDeudasSaldadas();
      return count === 0 ? 'No había deudas saldadas para borrar.' : 'Listo, borré ' + count + ' deuda' + (count === 1 ? '' : 's') + ' saldada' + (count === 1 ? '' : 's') + '.';
    }

    case 'borrar_todas_deudas': {
      setPendingAction(from, { tipo: 'borrar_todas_deudas' });
      return 'Vas a borrar *todas* las deudas (pendientes y saldadas). No hay vuelta atrás. ¿Confirmás?';
    }

    // ── Suscripciones ─────────────────────────────────────────────────────────
    case 'registrar_suscripcion': {
      const result  = await appendSuscripcion({ nombre: input.nombre, monto: input.monto || 0, dia: input.dia || 0, tipo: input.tipo, fechaFinPrueba: input.fecha_fin_prueba || '', divisa: input.divisa || 'ARS' });
      const esPrueba   = input.tipo === 'prueba';
      const divisaSub  = (input.divisa || 'ARS').toUpperCase();
      const signoSub   = divisaSub === 'USD' ? 'U$S ' : '$';
      const detalle    = esPrueba ? 'Prueba gratis hasta ' + input.fecha_fin_prueba : 'Día ' + input.dia + ' de cada mes · ' + signoSub + (input.monto || 0).toLocaleString('es-AR');
      return ['*[SUSCRIPCIÓN REGISTRADA — #' + result.id + ']*', '', 'Anotado.', result.nombre, detalle, 'Te aviso el día antes del vencimiento.'].join('\n');
    }

    case 'cancelar_suscripcion': {
      const result = await cancelarSuscripcion(input.nombre);
      return result ? '*' + result.nombre + '* cancelada. Ya no te aviso más.' : 'No encontré ninguna suscripción activa llamada "' + input.nombre + '".';
    }

    case 'editar_suscripcion': {
      const subs   = await getSuscripcionesActivas();
      const needle = input.nombre.toLowerCase();
      const sub    = subs.find(s => s.nombre.toLowerCase().includes(needle));
      if (!sub) return 'No encontré ninguna suscripción activa llamada "' + input.nombre + '".';

      const cambios = {
        nombre:        input.nuevo_nombre    ?? null,
        monto:         input.nuevo_monto     ?? null,
        dia:           input.nuevo_dia       ?? null,
        divisa:        input.nueva_divisa    ?? null,
        tipo:          input.nuevo_tipo      ?? null,
        fechaFinPrueba:input.nueva_fecha_fin ?? null,
      };
      const hayCambios = Object.values(cambios).some(v => v != null);
      if (!hayCambios) return 'Encontré *' + sub.nombre + '* pero no entendí qué querés cambiar.';

      const lineas = [];
      if (cambios.nombre     != null) lineas.push('Nombre: ' + sub.nombre + ' → *' + cambios.nombre + '*');
      if (cambios.monto      != null) lineas.push('Monto: $' + sub.monto + ' → *$' + cambios.monto + '*');
      if (cambios.dia        != null) lineas.push('Día: ' + sub.dia + ' → *' + cambios.dia + '*');
      if (cambios.divisa     != null) lineas.push('Divisa: ' + (sub.divisa || 'ARS') + ' → *' + cambios.divisa + '*');

      setPendingAction(from, { tipo: 'editar_suscripcion', nombreSub: sub.nombre, cambios });
      return 'Encontré *' + sub.nombre + '*. Cambios a aplicar:\n\n' + lineas.join('\n') + '\n\n¿Confirmás?';
    }

    case 'eliminar_suscripcion': {
      const subs   = await getSuscripcionesActivas();
      const needle = input.nombre.toLowerCase();
      const sub    = subs.find(s => s.nombre.toLowerCase().includes(needle));
      if (!sub) return 'No encontré ninguna suscripción activa llamada "' + input.nombre + '".';
      setPendingAction(from, { tipo: 'eliminar_suscripcion', nombreSub: sub.nombre });
      return 'Vas a eliminar *' + sub.nombre + '* del registro. ¿Confirmás?';
    }

    case 'ver_suscripciones': {
      const subs  = await getSuscripcionesActivas();
      if (subs.length === 0) return 'No tenés suscripciones activas registradas.';
      const pagas   = subs.filter(s => s.tipo === 'paga');
      const pruebas = subs.filter(s => s.tipo === 'prueba');
      const total   = pagas.reduce((sum, s) => sum + s.monto, 0);
      const lines   = ['*Suscripciones activas* 📱', ''];
      if (pagas.length > 0) {
        lines.push('*Pagas:*');
        pagas.forEach(s => {
          const divisa = (s.divisa || 'ARS').toUpperCase();
          const signo  = divisa === 'USD' ? 'U$S ' : '$';
          lines.push('  ' + s.nombre + ' · ' + signo + s.monto.toLocaleString('es-AR') + ' · día ' + s.dia);
        });
      }
      if (pruebas.length > 0) {
        lines.push(''); lines.push('*Pruebas gratis:*');
        pruebas.forEach(s => lines.push('  ' + s.nombre + ' · hasta ' + s.fechaFinPrueba));
      }
      lines.push(''); lines.push('*Total mensual: $' + total.toLocaleString('es-AR') + '*');
      return lines.join('\n');
    }

    case 'snooze_suscripcion': {
      const subs = await getSuscripcionesActivas();
      const sub  = input.nombre ? subs.find(s => s.nombre.toLowerCase().includes(input.nombre.toLowerCase())) : subs.find(s => s.snoozeHasta) || subs[0];
      if (!sub) return 'No encontré ninguna suscripción para postergar.';
      if (sub.snoozeCount >= MAX_SNOOZE) return 'Ya usaste el máximo de recordatorios para *' + sub.nombre + '*. No puedo postergarlo más.';
      const snoozeDate = new Date(Date.now() + SNOOZE_HOURS * 60 * 60 * 1000);
      await updateSnooze(sub.id, snoozeDate.toISOString());
      const horaStr   = snoozeDate.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      const restantes = MAX_SNOOZE - sub.snoozeCount - 1;
      return 'Te aviso *' + sub.nombre + '* a las ' + horaStr + '.' + (restantes > 0 ? ' Podés postergar ' + restantes + ' vez' + (restantes === 1 ? '' : 'es') + ' más.' : ' Este es el último recordatorio posible.');
    }

    // ── Eventos ───────────────────────────────────────────────────────────────
    case 'registrar_evento': {
      const avisoHora = input.aviso_hora || '08:00';
      const id      = await appendEvento({
        fecha:       input.fecha,
        hora:        input.hora        || '',
        tipo:        input.tipo        || '',
        descripcion: input.descripcion,
        avisoHora,
      });
      const horaStr = input.hora ? ' a las ' + input.hora : '';
      const tipoStr = input.tipo ? ' [' + input.tipo + ']' : '';
      return '*[EVENTO REGISTRADO — #' + id + ']*' + tipoStr + '\n\n' +
        input.descripcion + '\n' +
        '📅 ' + input.fecha + horaStr + '\n\n' +
        'Te aviso 3 días antes, 1 día antes y el mismo día a las ' + avisoHora + '.';
    }

    case 'ver_eventos': {
      const eventos = await getEventosFuturos();
      if (eventos.length === 0) return 'No tenés eventos futuros registrados.';

      const TIPO_LABEL = {
        turno:        'Turnos',
        examen:       'Exámenes',
        reunion:      'Reuniones',
        social:       'Social',
        pago:         'Pagos',
        recordatorio: 'Recordatorios',
        evento:       'Eventos',
        otro:         'Otros',
      };
      const TIPO_ORDER = ['turno', 'examen', 'reunion', 'social', 'pago', 'recordatorio', 'evento', 'otro'];

      const grupos = {};
      for (const e of eventos) {
        const key = (e.tipo || 'otro').toLowerCase();
        const grupo = TIPO_ORDER.includes(key) ? key : 'otro';
        if (!grupos[grupo]) grupos[grupo] = [];
        grupos[grupo].push(e);
      }

      const lines = ['*Próximos eventos* 📅'];
      for (const tipo of TIPO_ORDER) {
        if (!grupos[tipo]) continue;
        lines.push('');
        lines.push('*' + (TIPO_LABEL[tipo] || tipo) + '*');
        for (const e of grupos[tipo]) {
          const horaStr = e.hora ? ' · ' + e.hora : '';
          lines.push('  #' + e.id + ' ' + e.descripcion + ' — ' + e.fecha + horaStr);
        }
      }
      return lines.join('\n');
    }

    case 'editar_evento': {
      const todos = await getEventosFuturos();
      let candidatos = [];

      if (input.id != null) {
        const e = todos.find(ev => parseInt(ev.id) === parseInt(input.id));
        if (e) candidatos = [e];
      } else if (input.descripcion_busqueda) {
        const needle = input.descripcion_busqueda.toLowerCase();
        candidatos = todos.filter(e => e.descripcion.toLowerCase().includes(needle));
      }

      if (candidatos.length === 0)
        return 'No encontré ningún evento con esa descripción. Usá "ver eventos" para ver el listado con IDs.';

      if (candidatos.length > 1) {
        const lista = candidatos.map(e => {
          const h = e.hora ? ' · ' + e.hora : '';
          return '*#' + e.id + '* — ' + e.descripcion + ' · 📅 ' + e.fecha + h;
        }).join('\n');
        return 'Encontré varios eventos que coinciden:\n\n' + lista + '\n\nIndicame el *#ID* del que querés editar.';
      }

      const ev = candidatos[0];
      const cambios = {
        fecha:       input.nueva_fecha        || null,
        hora:        input.nueva_hora         || null,
        tipo:        input.nuevo_tipo         || null,
        descripcion: input.nueva_descripcion  || null,
        avisoHora:   input.nueva_aviso_hora   || null,
      };
      if (!Object.values(cambios).some(v => v != null))
        return 'Encontré *' + ev.descripcion + '* pero no entendí qué querés cambiar.';

      const lineas = [];
      if (cambios.fecha)       lineas.push('Fecha: ' + ev.fecha + ' → *' + cambios.fecha + '*');
      if (cambios.hora)        lineas.push('Hora: ' + (ev.hora || '(sin hora)') + ' → *' + cambios.hora + '*');
      if (cambios.tipo)        lineas.push('Tipo: ' + (ev.tipo || '(sin tipo)') + ' → *' + cambios.tipo + '*');
      if (cambios.descripcion) lineas.push('Descripción: ' + ev.descripcion + ' → *' + cambios.descripcion + '*');
      if (cambios.avisoHora)   lineas.push('Aviso mismo día: ' + (ev.avisoHora || '08:00') + ' → *' + cambios.avisoHora + '*');

      setPendingAction(from, { tipo: 'editar_evento', eventoId: ev.id, eventoDesc: ev.descripcion, cambios });
      return 'Evento encontrado: *' + ev.descripcion + '* · 📅 ' + ev.fecha + (ev.hora ? ' · ' + ev.hora : '') +
        '\n\nCambios:\n' + lineas.join('\n') + '\n\n¿Confirmás?';
    }

    case 'eliminar_evento': {
      const todos = await getEventosFuturos();
      let candidatos = [];

      if (input.id != null) {
        const e = todos.find(ev => parseInt(ev.id) === parseInt(input.id));
        if (e) candidatos = [e];
      } else if (input.descripcion) {
        const needle = input.descripcion.toLowerCase();
        candidatos = todos.filter(e => e.descripcion.toLowerCase().includes(needle));
      }

      if (candidatos.length === 0)
        return 'No encontré ningún evento con esa descripción. Usá "ver eventos" para ver el listado.';

      if (candidatos.length > 1) {
        const lista = candidatos.map(e => {
          const h = e.hora ? ' · ' + e.hora : '';
          return '*#' + e.id + '* — ' + e.descripcion + ' · 📅 ' + e.fecha + h;
        }).join('\n');
        return 'Encontré varios eventos que coinciden:\n\n' + lista + '\n\nIndicame el *#ID* del que querés eliminar.';
      }

      const ev = candidatos[0];
      setPendingAction(from, { tipo: 'eliminar_evento', eventoId: ev.id, eventoDesc: ev.descripcion, eventoFecha: ev.fecha });
      return 'Vas a eliminar:\n*' + ev.descripcion + '* · 📅 ' + ev.fecha + (ev.hora ? ' · ' + ev.hora : '') + '\n\n¿Confirmás?';
    }

    // ── Recordatorios ────────────────────────────────────────────────────────

    case 'registrar_recordatorio': {
      const id      = await appendRecordatorio({ fecha: input.fecha, hora: input.hora || '', descripcion: input.descripcion });
      const horaStr = input.hora ? ' a las ' + input.hora : ' a las 8:00';
      return '*Recordatorio anotado #' + id + '*\n\n' + input.descripcion + '\n📅 ' + input.fecha + horaStr;
    }

    case 'ver_recordatorios': {
      const recs = await getRecordatoriosPendientes();
      if (recs.length === 0) return 'No tenés recordatorios pendientes.';
      const lines = ['*Recordatorios pendientes*', ''];
      for (const r of recs) {
        const horaStr = r.hora ? ' · ' + r.hora : '';
        lines.push('  #' + r.id + ' ' + r.descripcion + ' — ' + r.fecha + horaStr);
      }
      return lines.join('\n');
    }

    case 'snooze_recordatorio': {
      const rec = await snoozeRecordatorio(input.id, input.descripcion_busqueda, input.horas);
      if (!rec) return 'No encontré el recordatorio. Usá "ver recordatorios" para verlos.';
      const hasta = new Date(rec.snoozeHasta).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
      return 'Ok, te recuerdo *' + rec.descripcion + '* a las ' + hasta + '.';
    }

    case 'eliminar_recordatorio': {
      const rec = await eliminarRecordatorio(input.id, input.descripcion_busqueda);
      if (!rec) return 'No encontré el recordatorio. Usá "ver recordatorios" para verlos.';
      return 'Recordatorio *' + rec.descripcion + '* eliminado.';
    }

    // ── Archivos ─────────────────────────────────────────────────────────────
    case 'guardar_archivo': {
      const pending = getPendingMedia(from);
      if (!pending) return 'No tengo ninguna imagen o PDF pendiente para guardar. Mandámelo primero.';

      const ext      = extFromMediaType(pending.mediaType);
      const filename = randomUUID() + ext;
      await ensureFilesDir();
      await writeFile(path.join(config.files.dir, filename), pending.buffer);

      const id = await appendArchivo({ nombre: input.nombre, tipo: pending.tipo, archivo: filename });
      return '*[ARCHIVO GUARDADO — #' + id + ']*\n' + input.nombre + '\n\nCuando lo necesites, pedímelo por nombre.';
    }

    case 'enviar_archivo': {
      const matches = await buscarArchivos(input.busqueda);
      if (matches.length === 0)
        return 'No encontré ningún archivo guardado con ese nombre. Usá "qué archivos tengo" para ver el listado.';

      if (matches.length > 1) {
        const lista = matches.map(a => '*#' + a.id + '* — ' + a.nombre + ' (' + a.tipo + ') · ' + a.fecha).join('\n');
        return 'Encontré varios archivos que coinciden:\n\n' + lista + '\n\nDecime con más precisión cuál.';
      }

      const archivo  = matches[0];
      const filePath = path.join(config.files.dir, archivo.archivo);
      if (!existsSync(filePath))
        return 'Encontré el registro de *' + archivo.nombre + '* pero el archivo ya no está en el servidor.';

      const buffer = await readFile(filePath);
      if (archivo.tipo === 'imagen') {
        await sock.sendMessage(from, { image: buffer, caption: archivo.nombre });
      } else {
        await sock.sendMessage(from, { document: buffer, mimetype: mimeFromArchivo(archivo.archivo), fileName: archivo.nombre + path.extname(archivo.archivo) });
      }
      return 'Ahí te mando *' + archivo.nombre + '*.';
    }

    case 'listar_archivos': {
      const archivos = await getArchivos();
      if (archivos.length === 0) return 'No tenés archivos guardados todavía.';
      const lista = archivos.map(a => '  #' + a.id + ' ' + a.nombre + ' (' + a.tipo + ') · ' + a.fecha).join('\n');
      return '*Archivos guardados* 📎\n\n' + lista;
    }

    // ── Reporte mensual ───────────────────────────────────────────────────────
    case 'ver_reporte_mensual': {
      const data = await getReporteMensual(-1);
      return formatReporteMensual(data);
    }

    // ── Confirmar / rechazar ──────────────────────────────────────────────────
    case 'confirmar_accion':
      return await handleConfirmacion(from, 'confirmar', '');

    case 'rechazar_accion':
      return await handleConfirmacion(from, 'rechazar', '');

    default:
      return 'No sé cómo manejar esa acción.';
  }
}

// ── Handler de confirmaciones (pending actions) ───────────────────────────────

async function handleConfirmacion(from, intent, body) {
  const pending = getPendingAction(from);

  if (!pending) return 'No hay ninguna acción pendiente de confirmar.';

  if (intent === 'rechazar') {
    clearPendingAction(from);
    return 'Cancelado. No se tocó nada.';
  }

  try {
    if (pending.tipo === 'update') {
      const updated = await updateRow(pending.rowIndex, pending.rowObject, pending.newData);
      clearPendingAction(from);
      setLastInteracted(from, updated, pending.rowIndex);
      return 'Gasto *#' + updated.id + '* actualizado:\n\n' + formatRow(updated);

    } else if (pending.tipo === 'delete') {
      await deleteRow(pending.rowIndex);
      clearPendingAction(from);
      popInteracted(from);
      return 'Eliminado.';

    } else if (pending.tipo === 'delete_multiple') {
      for (const row of pending.rows) await deleteRow(row.rowIndex);
      clearPendingAction(from);
      return 'Eliminado.';

    } else if (pending.tipo === 'editar_suscripcion') {
      const updated = await editarSuscripcion(pending.nombreSub, pending.cambios);
      clearPendingAction(from);
      const divisaSub = (updated?.divisa || 'ARS').toUpperCase();
      const signoSub  = divisaSub === 'USD' ? 'U$S ' : '$';
      return updated ? '*' + updated.nombre + '* actualizada. Monto: ' + signoSub + updated.monto + ' · Día: ' + updated.dia : 'Algo salió mal actualizando la suscripción.';

    } else if (pending.tipo === 'eliminar_suscripcion') {
      const eliminada = await eliminarSuscripcion(pending.nombreSub);
      clearPendingAction(from);
      return eliminada ? 'Eliminado.' : 'No encontré la suscripción para eliminar.';

    } else if (pending.tipo === 'editar_evento') {
      const updated = await editarEvento(pending.eventoId, pending.cambios);
      clearPendingAction(from);
      if (!updated) return 'No encontré el evento para editar. Puede que ya haya sido eliminado.';
      const h = updated.hora ? ' · ' + updated.hora : '';
      return 'Listo. *' + updated.descripcion + '* · 📅 ' + updated.fecha + h;

    } else if (pending.tipo === 'eliminar_evento') {
      const eliminado = await eliminarEvento(pending.eventoId);
      clearPendingAction(from);
      return eliminado
        ? 'Eliminado. *' + eliminado.descripcion + '* (' + eliminado.fecha + ') borrado.'
        : 'No encontré el evento. Puede que ya haya sido eliminado.';

    } else if (pending.tipo === 'borrar_todas_deudas') {
      const count = await borrarTodasDeudas();
      clearPendingAction(from);
      return count === 0 ? 'No había deudas registradas.' : 'Listo, borré ' + count + ' deuda' + (count === 1 ? '' : 's') + '.';

    } else if (pending.tipo === 'deuda_nueva_o_suma') {
      const txt = (body || '').trim().toLowerCase();
      if (txt === 'nueva' || txt === 'nueva deuda' || txt === 'registrar nueva') {
        const result = await appendDeuda(pending.parsedDeuda);
        clearPendingAction(from);
        const divisa = (pending.parsedDeuda.divisa || 'ARS').toUpperCase();
        const signo  = divisa === 'USD' ? 'U$S ' : '$';
        return '*[DEUDA REGISTRADA - #' + result.id + ']*\nAnotado.\nAcreedor: ' + result.acreedor + '\nMonto: ' + signo + result.montoTotal.toLocaleString('es-AR');
      }
      const match = (body || '').match(/#?(\d+)/);
      if (!match) return 'Respondé *nueva* para crear una deuda nueva, o el *#ID* al que sumar (ej: #3).';
      const result = await sumarDeuda(parseInt(match[1]), pending.parsedDeuda.montoTotal);
      clearPendingAction(from);
      if (!result) return 'No encontré la deuda #' + match[1] + '.';
      const divisa = (result.divisa || 'ARS').toUpperCase();
      const signo  = divisa === 'USD' ? 'U$S ' : '$';
      return '*[DEUDA ACTUALIZADA - #' + result.id + ']*\nNuevo total: ' + signo + result.montoTotal.toLocaleString('es-AR') + '\nSaldo: ' + signo + result.saldo.toLocaleString('es-AR');

    } else if (pending.tipo === 'elegir_deuda_pago') {
      const match = (body || '').match(/#?(\d+)/);
      if (!match) return 'Indicá el *#ID* de la deuda a pagar (ej: #3).';
      const result = await pagarDeuda(parseInt(match[1]), pending.montoPago);
      clearPendingAction(from);
      if (!result) return 'No encontré la deuda #' + match[1] + '.';
      const divisa = (result.divisa || 'ARS').toUpperCase();
      const signo  = divisa === 'USD' ? 'U$S ' : '$';
      const lines  = ['*[PAGO REGISTRADO]*', 'Acreedor: ' + result.acreedor, 'Pago: ' + signo + pending.montoPago.toLocaleString('es-AR')];
      if (result.estado === 'saldada') lines.push('Estado: *DEUDA SALDADA*');
      else lines.push('Saldo restante: ' + signo + result.saldo.toLocaleString('es-AR'));
      return lines.join('\n');

    } else if (pending.tipo === 'elegir_deuda_suma') {
      const match = (body || '').match(/#?(\d+)/);
      if (!match) return 'Indicá el *#ID* de la deuda a la que sumar (ej: #3).';
      const result = await sumarDeuda(parseInt(match[1]), pending.montoAdicional);
      clearPendingAction(from);
      if (!result) return 'No encontré la deuda #' + match[1] + '.';
      const divisa = (result.divisa || 'ARS').toUpperCase();
      const signo  = divisa === 'USD' ? 'U$S ' : '$';
      return '*[DEUDA ACTUALIZADA - #' + result.id + ']*\nNuevo total: ' + signo + result.montoTotal.toLocaleString('es-AR') + '\nSaldo: ' + signo + result.saldo.toLocaleString('es-AR');
    }
  } catch (err) {
    logger.error({ err }, 'Error ejecutando accion confirmada');
    clearPendingAction(from);
    return 'Algo salió mal. Intentalo de nuevo.';
  }

  return 'No entendí esa confirmación.';
}

// ── Handler principal de mensajes ─────────────────────────────────────────────

async function handleIncomingMessage(msg) {
  // extractMessageContent desenvuelve documentWithCaptionMessage, viewOnce, ephemeral, editado, etc.
  const content = extractMessageContent(msg.message) || {};

  const textBody =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.documentMessage?.caption ||
    null;

  const imageMsg    = content.imageMessage;
  const documentMsg = content.documentMessage;
  const audioMsg    = content.audioMessage;
  const hasMedia    = !!(imageMsg || documentMsg);
  const hasAudio    = !!audioMsg;

  if (!textBody && !hasMedia && !hasAudio) return;
  if (msg.key.fromMe) return;

  const from = msg.key.remoteJid;

  // ── Audio → transcribir con Whisper ──────────────────────────────────────────
  if (hasAudio) {
    try {
      const buffer    = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      const mimetype  = audioMsg.mimetype || 'audio/ogg';
      logger.info({ from, mimetype }, 'Audio recibido, transcribiendo...');
      const transcripcion = await transcribeAudio(buffer, mimetype);
      if (!transcripcion) { logger.warn({ from }, 'Transcripcion vacia'); return; }

      logger.info({ from, transcripcion }, 'Audio transcripto');
      pushHistory(from, 'user', '[audio] ' + transcripcion);

      const history       = getHistory(from);
      const recentRows    = await getRecentRows(20);
      const interactedStk = getInteractedStack(from);

      const { toolUses, textResp } = await processMessage(transcripcion, history, recentRows, interactedStk, undefined, true);

      let reply;
      if (toolUses.length > 0) {
        const resultados = [];
        for (const tu of toolUses) {
          try {
            const r = await executeTool(from, tu.name, tu.input, recentRows, true);
            resultados.push(r);
          } catch (e) {
            logger.error({ err: e, tool: tu.name }, 'Error ejecutando tool de audio');
            resultados.push('Error ejecutando ' + tu.name);
          }
        }
        reply = resultados.join('\n\n─────\n\n');
      } else {
        reply = textResp || 'No entendí el audio. Repetilo o escribilo.';
      }

      await sock.sendMessage(from, { text: reply });
      pushHistory(from, 'bot', reply);
    } catch (err) {
      logger.error({ err }, 'Error procesando audio');
      await sock.sendMessage(from, { text: 'No pude procesar el audio. Intentá de nuevo o escribilo.' }).catch(() => {});
    }
    return;
  }

  // ── Imagen o PDF nuevo → queda pendiente ─────────────────────────────────────
  if (hasMedia) {
    try {
      const buffer    = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      const mediaType = imageMsg?.mimetype || documentMsg?.mimetype || 'application/octet-stream';
      const tipo      = imageMsg ? 'imagen' : 'documento';
      setPendingMedia(from, { buffer, mediaType, tipo });
    } catch (err) {
      logger.error({ err }, 'Error descargando media');
    }
  }

  const pendingMed = getPendingMedia(from);
  const body = textBody || (pendingMed ? (pendingMed.tipo === 'imagen' ? '(imagen sin texto)' : '(documento sin texto)') : null);

  if (!body) return;

  logger.info({ from, body, hasMedia }, 'Mensaje recibido');
  pushHistory(from, 'user', body);

  try {
    const history       = getHistory(from);
    const recentRows    = await getRecentRows(20);
    const interactedStk = getInteractedStack(from);

    const PENDING_DESAMBIG = ['deuda_nueva_o_suma', 'elegir_deuda_pago', 'elegir_deuda_suma'];
    if (hasPendingAction(from)) {
      const pendTipo = getPendingAction(from)?.tipo;
      if (PENDING_DESAMBIG.includes(pendTipo)) {
        const reply = await handleConfirmacion(from, 'confirmar', body);
        await sock.sendMessage(from, { text: reply });
        pushHistory(from, 'bot', reply);
        return;
      }
    }

    const image = (pendingMed && pendingMed.tipo === 'imagen')
      ? { base64: pendingMed.buffer.toString('base64'), mediaType: pendingMed.mediaType }
      : undefined;

    const pendingRecs = necesitaRecordatorios(body)
      ? await getRecordatoriosPendientes().catch(() => [])
      : [];
    const { toolUses, textResp } = await processMessage(body, history, recentRows, interactedStk, image, false, pendingRecs);

    // Para mensajes de texto siempre es una sola tool (comportamiento original)
    const toolUse = toolUses[0] || null;
    let reply;

    if (toolUse) {
      const toolName = toolUse.name;
      const input    = toolUse.input;

      if (toolName === 'confirmar_accion' || toolName === 'rechazar_accion') {
        const intent = toolName === 'confirmar_accion' ? 'confirmar' : 'rechazar';
        if (!hasPendingAction(from)) {
          reply = 'No hay ninguna acción pendiente de confirmar.';
        } else {
          reply = await handleConfirmacion(from, intent, body);
        }
      } else {
        if (hasPendingAction(from)) {
          const pendTipo = getPendingAction(from)?.tipo;
          if (!PENDING_DESAMBIG.includes(pendTipo)) {
            clearPendingAction(from);
            logger.info({ from }, 'Pending cancelado por nuevo comando');
          }
        }
        reply = await executeTool(from, toolName, input, recentRows);

        if (toolName === 'guardar_archivo' || toolName === 'registrar_evento') {
          clearPendingMedia(from);
        } else if (getPendingMedia(from)) {
          clearPendingMedia(from);
          logger.info({ from }, 'Media pendiente descartada por nuevo comando');
        }
      }
    } else {
      reply = textResp || 'No entendí. Contame qué pasó con la guita.';
    }

    await sock.sendMessage(from, { text: reply });
    pushHistory(from, 'bot', reply);

  } catch (err) {
    logger.error({ err }, 'Error procesando mensaje');
    await sock.sendMessage(from, { text: 'Uy, algo explotó. Intentalo de nuevo.' }).catch(() => {});
  }
}

// ── Cliente WhatsApp ──────────────────────────────────────────────────────────

export async function startWhatsAppClient() {
  await ensureSessionDir();
  await ensureFilesDir();
  await ensureHeaders();
  await ensureEventosHeaders();
  await ensureArchivosHeaders();
  await ensureRecordatoriosHeaders();

  const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.sessionDir);

  const baileysLogger = logger.child({ module: 'baileys' });
  baileysLogger.level = 'silent';

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    printQRInTerminal: false,
    logger: baileysLogger,
    browser: ['ExpenseTracker', 'Chrome', '2.0.0'],
    generateHighQualityLinkPreview: false, syncFullHistory: false,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (config.whatsapp.authMethod === 'pairing') {
        if (!config.whatsapp.phoneNumber) { logger.error('WHATSAPP_PHONE_NUMBER requerido'); process.exit(1); }
        try {
          const code = await sock.requestPairingCode(config.whatsapp.phoneNumber);
          console.log('\n========================================');
          console.log('  PAIRING CODE: ' + code);
          console.log('  Ingresalo en: WhatsApp > Dispositivos vinculados');
          console.log('========================================\n');
        } catch (e) { logger.error({ e }, 'Error al solicitar pairing code'); }
      } else {
        console.log('\nEscaneá este QR con tu WhatsApp:\n');
        qrcode.generate(qr, { small: true });
        console.log('\n');
      }
    }

    if (connection === 'close') {
      const statusCode      = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : null;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn({ statusCode, shouldReconnect }, 'Conexion cerrada');
      if (shouldReconnect) { logger.info('Reconectando en 5s...'); setTimeout(() => startWhatsAppClient(), 5000); }
      else { logger.error('Sesion cerrada. Elimina el volumen wa_session y reinicia.'); process.exit(1); }
    }

    if (connection === 'open') {
      logger.info('WhatsApp conectado exitosamente!');
      startWeeklyScheduler(getSock, config.whatsapp.summaryJid);
      applyMonthFormatting().catch(err => logger.warn({ err }, 'applyMonthFormatting fallo al iniciar'));
      startSubscriptionScheduler(getSock, config.whatsapp.summaryJid);
      startMonthlyScheduler(getSock, config.whatsapp.summaryJid);
      startEventsScheduler(getSock, config.whatsapp.summaryJid);
      startRemindersScheduler(getSock, config.whatsapp.summaryJid);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) await handleIncomingMessage(msg);
  });

  return sock;
}
