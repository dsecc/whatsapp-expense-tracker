import { google } from 'googleapis';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

let sheetsClient = null;

// Estructura de columnas: A=ID B=Fecha C=Hora D=Tipo E=Monto F=Categoria G=Detalle H=Confianza
const COLUMNS  = ['id', 'fecha', 'hora', 'tipo', 'monto', 'categoria', 'detalle', 'confianza', 'divisa'];
const HEADERS  = ['ID', 'Fecha', 'Hora', 'Tipo', 'Monto', 'Categoria', 'Detalle', 'Confianza', 'Divisa'];
const RANGE    = 'A:I';
const HDR_RANGE = 'A1:I1';

// Categorias fijas del sistema
const CATEGORIAS = ['comida', 'social', 'recreacion', 'transporte', 'tecnologia', 'suscripciones', 'salud', 'hogar', 'otros'];

// ── Zona horaria Argentina ───────────────────────────────────────────────────
// Todas las fechas del sistema usan America/Argentina/Buenos_Aires explicitamente
// para evitar bugs cuando el container/servidor corre en UTC.

const TZ_AR = 'America/Argentina/Buenos_Aires';

// Devuelve un objeto con los componentes de fecha/hora actuales en AR
function nowAR() {
  const now = new Date();
  // Usamos Intl para extraer los componentes en la zona correcta
  const fmt = new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ_AR,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return {
    _raw:    now,
    year:    parseInt(parts.year),
    month:   parseInt(parts.month),   // 1-12
    day:     parseInt(parts.day),
    hour:    parseInt(parts.hour),
    minute:  parseInt(parts.minute),
    // fecha formateada dd/mm/yyyy lista para guardar en el Sheet
    fecha:   parts.day + '/' + parts.month + '/' + parts.year,
    // hora formateada HH:MM
    hora:    parts.hour + ':' + parts.minute,
    // Date a medianoche en AR (para comparaciones de dia)
    dateOnly: new Date(parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day)),
    // dia de semana 0=dom..6=sab en AR
    weekday: new Date(parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day)).getDay(),
  };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function getCredentials() {
  try {
    const raw = config.sheets.serviceAccountKey;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY no es JSON valido: ' + e.message);
  }
}

export async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const credentials = getCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  logger.info('Google Sheets client inicializado');
  return sheetsClient;
}

// ── Helpers internos ─────────────────────────────────────────────────────────

function rowToObject(row) {
  const obj = {};
  COLUMNS.forEach((col, i) => { obj[col] = row[i] ?? ''; });
  return obj;
}

async function getAllRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${config.sheets.sheetName}!${RANGE}`,
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return [];
  return rows.slice(1); // sin header
}

// Obtiene el sheetId numerico (necesario para batchUpdate / deleteDimension)
async function getSheetId() {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
  const sheet = meta.data.sheets.find(s => s.properties.title === config.sheets.sheetName);
  if (!sheet) throw new Error('Hoja "' + config.sheets.sheetName + '" no encontrada');
  return sheet.properties.sheetId;
}

// Nombre de mes en español
const NOMBRES_MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
export function nombreMesAnio(mes, anio) {
  return NOMBRES_MESES[mes - 1] + ' ' + anio;
}

// Parsea fecha "dd/mm/yyyy" a Date
function parseDate(str) {
  if (!str) return null;
  const parts = str.split('/');
  if (parts.length !== 3) return null;
  return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
}

// Inicio de la semana actual (lunes)
function getStartOfWeek() {
  const ar  = nowAR();
  const now = ar.dateOnly;
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(now.getDate() + diff);
  return start;
}

// Filtra filas de gastos por periodo
function filterByPeriod(rows, periodo, options = {}) {
  const ar  = nowAR();
  const now = ar._raw;
  const hoy = ar.dateOnly;

  return rows.filter(r => {
    if (r.tipo !== 'gasto') return false;
    const fecha = parseDate(r.fecha);
    if (!fecha) return false;

    if (periodo === 'hoy') {
      return fecha.toDateString() === hoy.toDateString();
    }
    if (periodo === 'ayer') {
      const ayer = new Date(hoy);
      ayer.setDate(hoy.getDate() - 1);
      return fecha.toDateString() === ayer.toDateString();
    }
    if (periodo === 'anteayer') {
      const anteayer = new Date(hoy);
      anteayer.setDate(hoy.getDate() - 2);
      return fecha.toDateString() === anteayer.toDateString();
    }
    if (periodo === 'dia_semana' && options?.fechaEspecifica) {
      const target = parseDate(options.fechaEspecifica);
      if (!target) return false;
      return fecha.toDateString() === target.toDateString();
    }
    if (periodo === 'semana') {
      return fecha >= getStartOfWeek() && fecha <= now;
    }
    if (periodo === 'mes') {
      return fecha.getMonth() === ar.month - 1 && fecha.getFullYear() === ar.year;
    }
    return false;
  });
}

// ── Exports principales ───────────────────────────────────────────────────────

// Crea headers si no existen
export async function ensureHeaders() {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheets.sheetId,
      range: `${config.sheets.sheetName}!${HDR_RANGE}`,
    });
    const existing = res.data.values?.[0];
    if (existing && existing.length > 0) {
      logger.info('Headers ya existen en el Sheet');
      return;
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheets.sheetId,
      range: `${config.sheets.sheetName}!${HDR_RANGE}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADERS] },
    });
    logger.info('Headers creados en Google Sheets');
  } catch (err) {
    logger.warn({ err: err.message }, 'No se pudieron verificar/crear headers');
  }
}

// Proximo ID disponible (max actual + 1)
export async function getNextId() {
  const rows = await getAllRows();
  if (rows.length === 0) return 1;
  const ids = rows.map(r => parseInt(r[0])).filter(n => !isNaN(n));
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

// Registrar un gasto/ingreso nuevo — devuelve el ID asignado
export async function appendExpense(data) {
  const sheets = await getSheetsClient();
  const { tipo, monto, categoria, descripcion, confianza } = data;

  const ar    = nowAR();
  const fecha = ar.fecha;
  const hora  = ar.hora;
  const id    = await getNextId();
  const divisa = data.divisa || 'ARS';

  // Orden: ID | Fecha | Hora | Tipo | Monto | Categoria | Detalle | Confianza | Divisa
  const row = [id, fecha, hora, tipo, monto, categoria, descripcion, confianza, divisa];

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.sheetId,
    range: `${config.sheets.sheetName}!${RANGE}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  logger.info({ id, row }, 'Fila agregada a Google Sheets');
  return id;
}

// Buscar una fila por ID exacto — devuelve { rowObject, rowIndex } o null
export async function findRowById(id) {
  const rows = await getAllRows();
  for (let i = 0; i < rows.length; i++) {
    if (parseInt(rows[i][0]) === parseInt(id)) {
      return { rowObject: rowToObject(rows[i]), rowIndex: i + 2 };
    }
  }
  return null;
}

// Buscar multiples filas por array de IDs en una sola lectura
// Devuelve array ordenado de mayor a menor rowIndex (critico para borrado sin desplazamiento)
export async function findRowsByIds(ids) {
  const rows  = await getAllRows();
  const idSet = new Set(ids.map(id => parseInt(id)));
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    if (idSet.has(parseInt(rows[i][0]))) {
      results.push({ rowObject: rowToObject(rows[i]), rowIndex: i + 2 });
    }
  }
  // Mayor → menor para borrar sin que los indices se desplacen
  results.sort((a, b) => b.rowIndex - a.rowIndex);
  return results;
}

// Actualizar una fila — solo los campos presentes en newData (los null se mantienen)
export async function updateRow(rowIndex, rowObject, newData) {
  const sheets = await getSheetsClient();

  const updated = {
    id:        rowObject.id,
    fecha:     rowObject.fecha,
    hora:      rowObject.hora,
    tipo:      newData.tipo       ?? rowObject.tipo,
    monto:     newData.monto      ?? rowObject.monto,
    categoria: newData.categoria  ?? rowObject.categoria,
    detalle:   newData.descripcion ?? rowObject.detalle,
    confianza: rowObject.confianza,
    divisa:    rowObject.divisa   || 'ARS',
  };

  const row = [updated.id, updated.fecha, updated.hora, updated.tipo,
               updated.monto, updated.categoria, updated.detalle, updated.confianza, updated.divisa];

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheets.sheetId,
    range: `${config.sheets.sheetName}!A${rowIndex}:I${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
  logger.info({ rowIndex, updated }, 'Fila actualizada en Google Sheets');
  return updated;
}

// Eliminar una fila fisicamente (no deja fila vacia) usando deleteDimension
export async function deleteRow(rowIndex) {
  const sheets  = await getSheetsClient();
  const sheetId = await getSheetId();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.sheets.sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex - 1, // batchUpdate es 0-based
            endIndex:   rowIndex,
          },
        },
      }],
    },
  });
  logger.info({ rowIndex }, 'Fila eliminada de Google Sheets');
}

// Ultimas N filas como rowObjects (para busqueda semantica)
export async function getRecentRows(n = 20) {
  const rows = await getAllRows();
  return rows.slice(-n).map(rowToObject);
}

// ── Funciones de resumen ──────────────────────────────────────────────────────

// Total de gastos para un periodo: 'hoy' | 'ayer' | 'anteayer' | 'semana' | 'mes'
export async function getTotalByPeriod(periodo) {
  const rows     = await getAllRows();
  const filtered = filterByPeriod(rows.map(rowToObject), periodo);
  const total    = filtered.reduce((sum, r) => sum + (parseFloat(r.monto) || 0), 0);
  return { total, count: filtered.length };
}

// Breakdown del mes actual por categoria
export async function getMonthlyCategoryBreakdown() {
  const rows     = await getAllRows();
  const filtered = filterByPeriod(rows.map(rowToObject), 'mes');

  const breakdown = {};
  for (const cat of CATEGORIAS) breakdown[cat] = 0;
  for (const r of filtered) {
    const cat = CATEGORIAS.includes(r.categoria) ? r.categoria : 'otros';
    breakdown[cat] += parseFloat(r.monto) || 0;
  }
  return { breakdown, total: Object.values(breakdown).reduce((a, b) => a + b, 0), count: filtered.length };
}

// Resumen semanal con breakdown por categoria (usado por el scheduler)
export async function getWeeklySummary() {
  const rows     = await getAllRows();
  const filtered = filterByPeriod(rows.map(rowToObject), 'semana');

  const breakdownARS = {};
  const breakdownUSD = {};
  for (const cat of CATEGORIAS) { breakdownARS[cat] = 0; breakdownUSD[cat] = 0; }

  for (const r of filtered) {
    const cat    = CATEGORIAS.includes(r.categoria) ? r.categoria : 'otros';
    const monto  = parseFloat(r.monto) || 0;
    const divisa = (r.divisa || 'ARS').toUpperCase();
    if (divisa === 'USD') breakdownUSD[cat] += monto;
    else breakdownARS[cat] += monto;
  }

  const totalARS = Object.values(breakdownARS).reduce((a, b) => a + b, 0);
  const totalUSD = Object.values(breakdownUSD).reduce((a, b) => a + b, 0);
  return { breakdownARS, breakdownUSD, totalARS, totalUSD, count: filtered.length };
}

// ── Hoja Recordatorios ────────────────────────────────────────────────────────
// Columnas: ID | Fecha | Hora | Descripcion | Estado | SnoozeHasta

const REC_SHEET = 'Recordatorios';
const REC_RANGE = 'A:F';

async function getAllRecordatorios() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: REC_SHEET + '!' + REC_RANGE,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return [];
  const hasHeader = rows[0][0]?.toString().trim().toUpperCase() === 'ID';
  return hasHeader ? rows.slice(1) : rows;
}

function rowToRecordatorio(row, index) {
  return {
    id:          row[0] ?? '',
    fecha:       row[1] ?? '',
    hora:        row[2] ?? '',
    descripcion: row[3] ?? '',
    estado:      row[4] ?? 'pendiente',
    snoozeHasta: row[5] ?? '',
    _rowIndex:   index + 2,
  };
}

async function getNextRecordatorioId() {
  const rows = await getAllRecordatorios();
  if (rows.length === 0) return 1;
  const ids = rows.map(r => parseInt(r[0])).filter(n => !isNaN(n));
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

async function writeRecordatorioRow(rowIndex, rec) {
  const sheets = await getSheetsClient();
  const row = [rec.id, rec.fecha, rec.hora, rec.descripcion, rec.estado, rec.snoozeHasta || ''];
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheets.sheetId,
    range: REC_SHEET + '!A' + rowIndex + ':F' + rowIndex,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

const REC_HEADERS = ['ID', 'Fecha', 'Hora', 'Descripcion', 'Estado', 'SnoozeHasta'];

export async function ensureRecordatoriosHeaders() {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheets.sheetId,
      range: REC_SHEET + '!A1:F1',
    });
    const existing = res.data.values?.[0] || [];
    const correct = REC_HEADERS.every((h, i) => existing[i]?.toString().trim() === h);
    if (correct) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheets.sheetId,
      range: REC_SHEET + '!A1:F1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [REC_HEADERS] },
    });
    logger.info('Headers de Recordatorios escritos/corregidos');
  } catch (err) {
    logger.warn({ err: err.message }, 'No se pudieron escribir headers de Recordatorios');
  }
}

export async function appendRecordatorio(data) {
  const sheets = await getSheetsClient();
  const id  = await getNextRecordatorioId();
  const row = [id, data.fecha, data.hora || '', data.descripcion, 'pendiente', ''];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.sheetId,
    range: REC_SHEET + '!' + REC_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  logger.info({ id, data }, 'Recordatorio registrado');
  return id;
}

export async function getRecordatoriosPendientes() {
  const rows = await getAllRecordatorios();
  return rows
    .map((r, i) => rowToRecordatorio(r, i))
    .filter(r => r.estado !== 'hecho');
}

export async function findRecordatorio(id, descripcionBusqueda) {
  const rows = await getAllRecordatorios();
  for (let i = 0; i < rows.length; i++) {
    const r = rowToRecordatorio(rows[i], i);
    if (r.estado !== 'pendiente') continue;
    if (id && parseInt(r.id) === parseInt(id)) return r;
    if (descripcionBusqueda && r.descripcion.toLowerCase().includes(descripcionBusqueda.toLowerCase())) return r;
  }
  return null;
}

export async function snoozeRecordatorio(id, descripcionBusqueda, horas) {
  const rec = await findRecordatorio(id, descripcionBusqueda);
  if (!rec) return null;
  rec.snoozeHasta = new Date(Date.now() + horas * 3600000).toISOString();
  await writeRecordatorioRow(rec._rowIndex, rec);
  logger.info({ id: rec.id, snoozeHasta: rec.snoozeHasta }, 'Recordatorio snoozed');
  return rec;
}

export async function clearRecordatorioSnooze(id) {
  const rows = await getAllRecordatorios();
  for (let i = 0; i < rows.length; i++) {
    const r = rowToRecordatorio(rows[i], i);
    if (parseInt(r.id) === parseInt(id)) {
      r.snoozeHasta = '';
      await writeRecordatorioRow(r._rowIndex, r);
      return r;
    }
  }
}

export async function completarRecordatorio(id, descripcionBusqueda) {
  const rec = await findRecordatorio(id, descripcionBusqueda);
  if (!rec) return null;
  rec.estado = 'hecho';
  rec.snoozeHasta = '';
  await writeRecordatorioRow(rec._rowIndex, rec);
  logger.info({ id: rec.id }, 'Recordatorio completado');
  return rec;
}

export async function eliminarRecordatorio(id, descripcionBusqueda) {
  const rec = await findRecordatorio(id, descripcionBusqueda);
  if (!rec) return null;
  const sheets  = await getSheetsClient();
  const meta    = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
  const sheet   = meta.data.sheets.find(s => s.properties.title === REC_SHEET);
  const sheetId = sheet.properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.sheets.sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: rec._rowIndex - 1, endIndex: rec._rowIndex },
        },
      }],
    },
  });
  logger.info({ id: rec.id }, 'Recordatorio eliminado');
  return rec;
}

// ── Hoja Ayuda ────────────────────────────────────────────────────────────────
// Columnas: ID | Fecha | Monto | De quien | Descripcion

const AYUDA_SHEET  = 'Ayuda';
const AYUDA_RANGE  = 'A:E';
const AYUDA_HDR    = 'A1:E1';
const AYUDA_HEADERS = ['ID', 'Fecha', 'Monto', 'De quien', 'Descripcion', 'Divisa'];

// Obtiene el proximo ID de la hoja Ayuda
async function getNextAyudaId() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${AYUDA_SHEET}!${AYUDA_RANGE}`,
  });
  const rows = (res.data.values || []).slice(1);
  if (rows.length === 0) return 1;
  const ids = rows.map(r => parseInt(r[0])).filter(n => !isNaN(n));
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

// Registra una ayuda economica en la hoja Ayuda
export async function appendAyuda(data) {
  const sheets = await getSheetsClient();
  const { monto, deQuien, descripcion } = data;

  const ar    = nowAR();
  const fecha = ar.fecha;
  const id    = await getNextAyudaId();

  const divisa = (data.divisa || 'ARS').toUpperCase();
  const row = [id, fecha, monto, deQuien, descripcion, divisa];

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.sheetId,
    range: `${AYUDA_SHEET}!${AYUDA_RANGE}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  logger.info({ id, row }, 'Ayuda registrada en Google Sheets');
  return id;
}

// Devuelve el resumen de ayudas del mes actual agrupado por origen
export async function getMonthlyAyuda() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${AYUDA_SHEET}!${AYUDA_RANGE}`,
  });

  const rows = (res.data.values || []).slice(1); // sin header
  const ar   = nowAR();

  // Filtrar por mes actual usando la fecha de la columna B (indice 1)
  const filtered = rows.filter(r => {
    const fecha = parseDate(r[1]);
    if (!fecha) return false;
    return fecha.getMonth() === ar.month - 1 && fecha.getFullYear() === ar.year;
  });

  // Agrupar por "De quien" (columna D, indice 3)
  const porOrigen = {};
  let total = 0;
  for (const r of filtered) {
    const origen = r[3] || 'desconocido';
    const monto  = parseFloat(r[2]) || 0;
    porOrigen[origen] = (porOrigen[origen] || 0) + monto;
    total += monto;
  }

  return { porOrigen, total, count: filtered.length };
}

// ── Hoja Deudas ───────────────────────────────────────────────────────────────
// Columnas: ID | Fecha | Acreedor | Monto total | Monto pagado | Saldo | Estado | Descripcion

const DEUDAS_SHEET = 'Deudas';
const DEUDAS_RANGE = 'A:H';

// Lee todas las filas de la hoja Deudas (sin header)
export async function getAllDeudas() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: DEUDAS_SHEET + '!' + DEUDAS_RANGE,
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return [];
  return rows.slice(1);
}

// Convierte fila a objeto deuda
// Orden: ID | Fecha | Acreedor | MontoTotal | MontoPagado | Saldo | Estado | Descripcion
export function rowToDeuda(row) {
  return {
    id:          row[0] ?? '',
    fecha:       row[1] ?? '',
    acreedor:    row[2] ?? '',
    montoTotal:  parseFloat(row[3]) || 0,
    montoPagado: parseFloat(row[4]) || 0,
    saldo:       parseFloat(row[5]) || 0,
    estado:      row[6] ?? 'pendiente',
    descripcion: row[7] ?? '',
  };
}

// Proximo ID para la hoja Deudas
async function getNextDeudaId() {
  const rows = await getAllDeudas();
  if (rows.length === 0) return 1;
  const ids = rows.map(r => parseInt(r[0])).filter(n => !isNaN(n));
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

// Registra una deuda nueva (monto pagado = 0, estado = pendiente)
export async function appendDeuda(data) {
  const sheets = await getSheetsClient();
  const { acreedor, montoTotal, descripcion } = data;
  const ar    = nowAR();
  const fecha = ar.fecha;
  const id    = await getNextDeudaId();
  const saldo = montoTotal;

  const divisa = (data.divisa || 'ARS').toUpperCase();
  const row = [id, fecha, acreedor, montoTotal, 0, saldo, 'pendiente', descripcion, divisa];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.sheetId,
    range: DEUDAS_SHEET + '!' + DEUDAS_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  logger.info({ id, row }, 'Deuda registrada');
  return { id, acreedor, montoTotal, saldo };
}

// Registra un pago parcial o total sobre una deuda existente
// Busca por nombre de acreedor (case-insensitive), actualiza monto pagado y saldo
// Busca deudas pendientes de un acreedor por nombre — devuelve array
export async function buscarDeudasPorAcreedor(nombreAcreedor) {
  const rows   = await getAllDeudas();
  const needle = nombreAcreedor.toLowerCase();
  const result = [];
  for (let i = 0; i < rows.length; i++) {
    const d = rowToDeuda(rows[i]);
    if (d.acreedor.toLowerCase().includes(needle) && d.estado === 'pendiente') {
      result.push({ ...d, _rowIndex: i + 2 });
    }
  }
  return result;
}

// Registra un pago sobre una deuda especifica por ID numerico
export async function pagarDeuda(deudaId, montoPago) {
  const sheets = await getSheetsClient();
  const rows   = await getAllDeudas();

  let rowIndex = null;
  let deuda    = null;
  for (let i = 0; i < rows.length; i++) {
    const d = rowToDeuda(rows[i]);
    if (parseInt(d.id) === parseInt(deudaId)) {
      rowIndex = i + 2;
      deuda    = d;
      break;
    }
  }

  if (!deuda) return null;

  const nuevoMontoPagado = deuda.montoPagado + montoPago;
  const nuevoSaldo       = Math.max(0, deuda.montoTotal - nuevoMontoPagado);
  const nuevoEstado      = nuevoSaldo === 0 ? 'saldada' : 'pendiente';

  const row = [
    deuda.id, deuda.fecha, deuda.acreedor,
    deuda.montoTotal, nuevoMontoPagado, nuevoSaldo,
    nuevoEstado, deuda.descripcion,
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheets.sheetId,
    range: DEUDAS_SHEET + '!A' + rowIndex + ':H' + rowIndex,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });

  logger.info({ deudaId, montoPago, nuevoSaldo, nuevoEstado }, 'Pago de deuda registrado');
  return { ...deuda, montoPagado: nuevoMontoPagado, saldo: nuevoSaldo, estado: nuevoEstado };
}

// Suma monto adicional a una deuda existente por ID (aumenta montoTotal y saldo)
export async function sumarDeuda(deudaId, montoAdicional) {
  const sheets = await getSheetsClient();
  const rows   = await getAllDeudas();

  let rowIndex = null;
  let deuda    = null;
  for (let i = 0; i < rows.length; i++) {
    const d = rowToDeuda(rows[i]);
    if (parseInt(d.id) === parseInt(deudaId)) {
      rowIndex = i + 2;
      deuda    = d;
      break;
    }
  }

  if (!deuda) return null;

  const nuevoMontoTotal = deuda.montoTotal + montoAdicional;
  const nuevoSaldo      = deuda.saldo + montoAdicional;

  const row = [
    deuda.id, deuda.fecha, deuda.acreedor,
    nuevoMontoTotal, deuda.montoPagado, nuevoSaldo,
    'pendiente', deuda.descripcion,
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheets.sheetId,
    range: DEUDAS_SHEET + '!A' + rowIndex + ':H' + rowIndex,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });

  logger.info({ deudaId, montoAdicional, nuevoMontoTotal, nuevoSaldo }, 'Deuda aumentada');
  return { ...deuda, montoTotal: nuevoMontoTotal, saldo: nuevoSaldo, estado: 'pendiente' };
}

// Devuelve todas las deudas pendientes para el resumen
export async function getResumenDeudas() {
  const rows     = await getAllDeudas();
  const pendientes = rows.map(rowToDeuda).filter(d => d.estado === 'pendiente');
  const total    = pendientes.reduce((sum, d) => sum + d.saldo, 0);
  return { pendientes, total };
}


// Borra fisicamente todas las filas de deudas (saldadas + pendientes)
export async function borrarTodasDeudas() {
  const sheets  = await getSheetsClient();
  const rows    = await getAllDeudas();
  if (rows.length === 0) return 0;

  const meta    = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
  const sheet   = meta.data.sheets.find(s => s.properties.title === DEUDAS_SHEET);
  const sheetId = sheet.properties.sheetId;

  const requests = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const rowIndex = i + 2;
    requests.push({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex },
      },
    });
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.sheets.sheetId,
    requestBody: { requests },
  });
  logger.info({ count: rows.length }, 'Todas las deudas borradas');
  return rows.length;
}

// Borra fisicamente solo las filas de deudas con estado saldada
export async function borrarDeudasSaldadas() {
  const sheets  = await getSheetsClient();
  const rows    = await getAllDeudas();
  const saldadas = rows
    .map((r, i) => ({ ...rowToDeuda(r), _rowIndex: i + 2 }))
    .filter(d => d.estado === 'saldada');

  if (saldadas.length === 0) return 0;

  const meta    = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
  const sheet   = meta.data.sheets.find(s => s.properties.title === DEUDAS_SHEET);
  const sheetId = sheet.properties.sheetId;

  const requests = saldadas
    .sort((a, b) => b._rowIndex - a._rowIndex)
    .map(d => ({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: d._rowIndex - 1, endIndex: d._rowIndex },
      },
    }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.sheets.sheetId,
    requestBody: { requests },
  });
  logger.info({ count: saldadas.length }, 'Deudas saldadas borradas');
  return saldadas.length;
}

// Aplica formato de color alternado por mes en la hoja principal (Opcion B)
// Alterna blanco puro / gris suave cada vez que cambia el mes
export async function applyMonthFormatting() {
  const sheets  = await getSheetsClient();
  const rows    = await getAllRows();
  if (rows.length === 0) return;

  const meta    = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
  const sheet   = meta.data.sheets.find(s => s.properties.title === config.sheets.sheetName);
  const sheetId = sheet.properties.sheetId;

  const COLORS = [
    { red: 1,     green: 1,     blue: 1     },
    { red: 0.953, green: 0.953, blue: 0.953 },
  ];

  let colorIndex   = 0;
  let lastMonthKey = null;
  const requests   = [];

  rows.forEach((row, i) => {
    const fechaStr = row[1] ?? '';
    const parts    = fechaStr.split('/');
    const monthKey = parts.length === 3 ? parts[2] + '-' + parts[1] : null;

    if (monthKey && monthKey !== lastMonthKey) {
      colorIndex   = lastMonthKey === null ? 0 : 1 - colorIndex;
      lastMonthKey = monthKey;
    }

    const rowIndex = i + 2;
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: rowIndex - 1, endRowIndex: rowIndex, startColumnIndex: 0, endColumnIndex: 9 },
        cell: { userEnteredFormat: { backgroundColor: COLORS[colorIndex] } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
  });

  const CHUNK = 500;
  for (let i = 0; i < requests.length; i += CHUNK) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheets.sheetId,
      requestBody: { requests: requests.slice(i, i + CHUNK) },
    });
  }
  logger.info({ rows: rows.length }, 'Formato de meses aplicado al Sheet');
}


// ── Hoja Suscripciones ────────────────────────────────────────────────────────
// Columnas: ID | Nombre | Monto | Dia | Tipo | FechaFinPrueba | Estado | SnoozeHasta | SnoozeCount

const SUBS_SHEET = 'Suscripciones';
const SUBS_RANGE = 'A:J';

async function getAllSubs() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: SUBS_SHEET + '!' + SUBS_RANGE,
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return [];
  return rows.slice(1);
}

function rowToSub(row, index) {
  return {
    id:             row[0] ?? '',
    nombre:         row[1] ?? '',
    monto:          parseFloat(row[2]) || 0,
    dia:            parseInt(row[3]) || 0,
    tipo:           row[4] ?? 'paga',
    fechaFinPrueba: row[5] ?? '',
    estado:         row[6] ?? 'activa',
    snoozeHasta:    row[7] ?? '',
    snoozeCount:    parseInt(row[8]) || 0,
    divisa:         row[9] ?? 'ARS',
    _rowIndex:      index + 2,
  };
}

async function getNextSubId() {
  const rows = await getAllSubs();
  if (rows.length === 0) return 1;
  const ids = rows.map(r => parseInt(r[0])).filter(n => !isNaN(n));
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

// Escribe una fila completa de suscripcion en el Sheet
async function writeSubRow(rowIndex, sub) {
  const sheets = await getSheetsClient();
  const row = [
    sub.id, sub.nombre, sub.monto, sub.dia,
    sub.tipo, sub.fechaFinPrueba, sub.estado,
    sub.snoozeHasta, sub.snoozeCount, sub.divisa || 'ARS',
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheets.sheetId,
    range: SUBS_SHEET + '!A' + rowIndex + ':J' + rowIndex,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// Registra una suscripcion nueva
export async function appendSuscripcion(data) {
  const sheets = await getSheetsClient();
  const { nombre, monto, dia, tipo, fechaFinPrueba } = data;
  const id  = await getNextSubId();
  const divisa = (data.divisa || 'ARS').toUpperCase();
  const row = [id, nombre, monto || 0, dia || 0, tipo, fechaFinPrueba || '', 'activa', '', 0, divisa];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.sheetId,
    range: SUBS_SHEET + '!' + SUBS_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  logger.info({ id, nombre, tipo }, 'Suscripcion registrada');
  return { id, nombre, monto, dia, tipo, fechaFinPrueba };
}

// Devuelve todas las suscripciones activas
export async function getSuscripcionesActivas() {
  const rows = await getAllSubs();
  return rows.map((r, i) => rowToSub(r, i)).filter(s => s.estado === 'activa');
}

// Marca una suscripcion como cancelada buscando por nombre
export async function cancelarSuscripcion(nombre) {
  const rows = await getAllSubs();
  const needle = nombre.toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const sub = rowToSub(rows[i], i);
    if (sub.nombre.toLowerCase().includes(needle) && sub.estado === 'activa') {
      sub.estado = 'cancelada';
      await writeSubRow(sub._rowIndex, sub);
      logger.info({ nombre: sub.nombre }, 'Suscripcion cancelada');
      return sub;
    }
  }
  return null;
}

// Edita campos de una suscripcion activa buscando por nombre
export async function editarSuscripcion(nombre, cambios) {
  const rows = await getAllSubs();
  const needle = nombre.toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const sub = rowToSub(rows[i], i);
    if (sub.nombre.toLowerCase().includes(needle) && sub.estado === 'activa') {
      if (cambios.nombre    != null) sub.nombre         = cambios.nombre;
      if (cambios.monto     != null) sub.monto          = cambios.monto;
      if (cambios.dia       != null) sub.dia            = cambios.dia;
      if (cambios.tipo      != null) sub.tipo           = cambios.tipo;
      if (cambios.divisa    != null) sub.divisa         = cambios.divisa.toUpperCase();
      if (cambios.fechaFinPrueba != null) sub.fechaFinPrueba = cambios.fechaFinPrueba;
      await writeSubRow(sub._rowIndex, sub);
      logger.info({ nombre: sub.nombre, cambios }, 'Suscripcion editada');
      return sub;
    }
  }
  return null;
}

// Elimina (borra la fila) de una suscripcion buscando por nombre
export async function eliminarSuscripcion(nombre) {
  const sheets  = await getSheetsClient();
  const rows    = await getAllSubs();
  const needle  = nombre.toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const sub = rowToSub(rows[i], i);
    if (sub.nombre.toLowerCase().includes(needle) && sub.estado === 'activa') {
      // Obtener spreadsheetId y sheetId numérico para deleteDimension
      const meta    = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
      const sheet   = meta.data.sheets.find(s => s.properties.title === SUBS_SHEET);
      const sheetId = sheet.properties.sheetId;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.sheets.sheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: sub._rowIndex - 1,  // 0-based
                endIndex:   sub._rowIndex,
              },
            },
          }],
        },
      });
      logger.info({ nombre: sub.nombre }, 'Suscripcion eliminada');
      return sub;
    }
  }
  return null;
}

// Actualiza snooze de una suscripcion: guarda hasta-cuando y suma el contador
export async function updateSnooze(subId, snoozeHasta) {
  const rows = await getAllSubs();
  for (let i = 0; i < rows.length; i++) {
    const sub = rowToSub(rows[i], i);
    if (parseInt(sub.id) === parseInt(subId)) {
      sub.snoozeHasta  = snoozeHasta;
      sub.snoozeCount  = sub.snoozeCount + 1;
      await writeSubRow(sub._rowIndex, sub);
      logger.info({ subId, snoozeHasta, count: sub.snoozeCount }, 'Snooze actualizado');
      return sub;
    }
  }
  return null;
}

// Limpia el snooze de una suscripcion (despues de que el aviso se disparo)
export async function clearSnooze(subId) {
  const rows = await getAllSubs();
  for (let i = 0; i < rows.length; i++) {
    const sub = rowToSub(rows[i], i);
    if (parseInt(sub.id) === parseInt(subId)) {
      sub.snoozeHasta = '';
      await writeSubRow(sub._rowIndex, sub);
      return sub;
    }
  }
}

// ── Resumen con soporte ARS/USD ───────────────────────────────────────────────

/**
 * Devuelve gastos del periodo separados por divisa
 * periodo: 'hoy' | 'ayer' | 'anteayer' | 'semana' | 'mes'
 * tipoCambio: numero opcional para unificar (Opcion B)
 */
export async function getTotalByPeriodConDivisa(periodo, tipoCambio = null, mesNumero = null, anio = null, fechaEspecifica = null) {
  const rows = await getAllRows();
  let filtered;
  if (periodo === 'mes_especifico' && mesNumero != null && anio != null) {
    filtered = rows.map(rowToObject).filter(r => {
      if (r.tipo !== 'gasto') return false;
      const fecha = parseDate(r.fecha);
      if (!fecha) return false;
      return fecha.getMonth() === mesNumero - 1 && fecha.getFullYear() === anio;
    });
  } else {
    filtered = filterByPeriod(rows.map(rowToObject), periodo, { fechaEspecifica: fechaEspecifica });
  }

  const ars = { total: 0, count: 0 };
  const usd = { total: 0, count: 0 };

  for (const r of filtered) {
    const monto  = parseFloat(r.monto) || 0;
    const divisa = (r.divisa || 'ARS').toUpperCase();
    if (divisa === 'USD') {
      usd.total += monto;
      usd.count++;
    } else {
      ars.total += monto;
      ars.count++;
    }
  }

  const totalUnificado = tipoCambio
    ? ars.total + (usd.total * tipoCambio)
    : null;

  return { ars, usd, totalUnificado, tipoCambio, count: filtered.length };
}

/**
 * Breakdown del mes por categoria separado por divisa
 */
export async function getMonthlyCategoryBreakdownConDivisa(mesNumero = null, anio = null) {
  const rows = await getAllRows();
  let filtered;
  if (mesNumero != null && anio != null) {
    filtered = rows.map(rowToObject).filter(r => {
      if (r.tipo !== 'gasto') return false;
      const fecha = parseDate(r.fecha);
      if (!fecha) return false;
      return fecha.getMonth() === mesNumero - 1 && fecha.getFullYear() === anio;
    });
  } else {
    filtered = filterByPeriod(rows.map(rowToObject), 'mes');
  }

  const breakdownARS = {};
  const breakdownUSD = {};
  for (const cat of CATEGORIAS) {
    breakdownARS[cat] = 0;
    breakdownUSD[cat] = 0;
  }

  for (const r of filtered) {
    const cat    = CATEGORIAS.includes(r.categoria) ? r.categoria : 'otros';
    const monto  = parseFloat(r.monto) || 0;
    const divisa = (r.divisa || 'ARS').toUpperCase();
    if (divisa === 'USD') breakdownUSD[cat] += monto;
    else breakdownARS[cat] += monto;
  }

  const totalARS = Object.values(breakdownARS).reduce((a, b) => a + b, 0);
  const totalUSD = Object.values(breakdownUSD).reduce((a, b) => a + b, 0);

  return { breakdownARS, breakdownUSD, totalARS, totalUSD, count: filtered.length };
}

/**
 * Genera todos los datos para el reporte mensual
 * mesOffset: 0 = mes actual, -1 = mes anterior (default para reporte)
 */
export async function getReporteMensual(mesOffset = -1) {
  const rows = await getAllRows();
  const ar   = nowAR();
  const targetMes  = new Date(ar.year, ar.month - 1 + mesOffset, 1);
  const mesNum     = targetMes.getMonth();
  const anioNum    = targetMes.getFullYear();

  // Filtrar por mes objetivo
  const filtered = rows.map(rowToObject).filter(r => {
    if (r.tipo !== 'gasto') return false;
    const fecha = parseDate(r.fecha);
    if (!fecha) return false;
    return fecha.getMonth() === mesNum && fecha.getFullYear() === anioNum;
  });

  // Breakdown por categoria y divisa
  const breakdownARS = {};
  const breakdownUSD = {};
  for (const cat of CATEGORIAS) { breakdownARS[cat] = 0; breakdownUSD[cat] = 0; }
  let totalARS = 0, totalUSD = 0;

  for (const r of filtered) {
    const cat    = CATEGORIAS.includes(r.categoria) ? r.categoria : 'otros';
    const monto  = parseFloat(r.monto) || 0;
    const divisa = (r.divisa || 'ARS').toUpperCase();
    if (divisa === 'USD') { breakdownUSD[cat] += monto; totalUSD += monto; }
    else { breakdownARS[cat] += monto; totalARS += monto; }
  }

  // Ayuda del mes objetivo
  let ayudaData = { porOrigen: {}, total: 0, count: 0 };
  try {
    const sheets = await getSheetsClient();
    const resAyuda = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheets.sheetId,
      range: 'Ayuda!A:E',
    });
    const ayudaRows = (resAyuda.data.values || []).slice(1);
    const ayudaFilt = ayudaRows.filter(r => {
      const f = parseDate(r[1]);
      return f && f.getMonth() === mesNum && f.getFullYear() === anioNum;
    });
    for (const r of ayudaFilt) {
      const origen = r[3] || 'Desconocido';
      const monto  = parseFloat(r[2]) || 0;
      ayudaData.porOrigen[origen] = (ayudaData.porOrigen[origen] || 0) + monto;
      ayudaData.total += monto;
      ayudaData.count++;
    }
  } catch (e) { /* si falla, ignorar */ }

  // Deudas pendientes (siempre actuales, no del mes)
  const { pendientes, total: totalDeudas } = await getResumenDeudas();

  const nombreMes = targetMes.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });

  return {
    nombreMes,
    breakdownARS, breakdownUSD,
    totalARS, totalUSD,
    ayuda: ayudaData,
    deudas: { pendientes, total: totalDeudas },
    count: filtered.length,
  };
}

// ── Hoja Eventos ──────────────────────────────────────────────────────────────
// Columnas: ID | Fecha | Hora | Tipo | Descripcion | AvisoHora

const EVENTOS_SHEET  = 'Eventos';
const EVENTOS_RANGE  = 'A:F';
const AVISO_HORA_DEFAULT = '08:00';

async function getAllEventos() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: EVENTOS_SHEET + '!' + EVENTOS_RANGE,
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return [];
  return rows.slice(1);
}

function rowToEvento(row, index) {
  return {
    id:          row[0] ?? '',
    fecha:       row[1] ?? '',
    hora:        row[2] ?? '',
    tipo:        row[3] ?? '',
    descripcion: row[4] ?? '',
    avisoHora:   row[5] || AVISO_HORA_DEFAULT,
    _rowIndex:   index + 2,
  };
}

async function getNextEventoId() {
  const rows = await getAllEventos();
  if (rows.length === 0) return 1;
  const ids = rows.map(r => parseInt(r[0])).filter(n => !isNaN(n));
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

// Registra un evento nuevo en la hoja Eventos
export async function appendEvento(data) {
  const sheets = await getSheetsClient();
  const id     = await getNextEventoId();
  const row    = [id, data.fecha, data.hora || '', data.tipo || '', data.descripcion, data.avisoHora || AVISO_HORA_DEFAULT];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.sheetId,
    range: EVENTOS_SHEET + '!' + EVENTOS_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  logger.info({ id, row }, 'Evento registrado');
  return id;
}

// Devuelve todos los eventos futuros (fecha >= hoy), ordenados por fecha
export async function getEventosFuturos() {
  const rows = await getAllEventos();
  const ar   = nowAR();
  return rows
    .map((r, i) => rowToEvento(r, i))
    .filter(e => {
      const f = parseDate(e.fecha);
      if (!f) return false;
      return f >= ar.dateOnly;
    })
    .sort((a, b) => {
      const fa = parseDate(a.fecha);
      const fb = parseDate(b.fecha);
      return fa - fb;
    });
}

// Crea los headers de la hoja Eventos si no existen
export async function ensureEventosHeaders() {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheets.sheetId,
      range: EVENTOS_SHEET + '!A1:F1',
    });
    const existing = res.data.values?.[0] || [];

    if (existing.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.sheets.sheetId,
        range: EVENTOS_SHEET + '!A1:F1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['ID', 'Fecha', 'Hora', 'Tipo', 'Descripcion', 'AvisoHora']] },
      });
      logger.info('Headers de Eventos creados');
      return;
    }

    // Migracion: hoja vieja sin columna AvisoHora → se agrega sola
    if (existing.length < 6 || !existing[5]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.sheets.sheetId,
        range: EVENTOS_SHEET + '!F1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['AvisoHora']] },
      });
      logger.info('Columna AvisoHora agregada a hoja Eventos existente');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'No se pudieron crear/migrar headers de Eventos');
  }
}

// Edita campos de un evento por ID
export async function editarEvento(eventoId, cambios) {
  const sheets = await getSheetsClient();
  const rows   = await getAllEventos();
  for (let i = 0; i < rows.length; i++) {
    const e = rowToEvento(rows[i], i);
    if (parseInt(e.id) === parseInt(eventoId)) {
      const updated = {
        id:          e.id,
        fecha:       cambios.fecha       ?? e.fecha,
        hora:        cambios.hora        ?? e.hora,
        tipo:        cambios.tipo        ?? e.tipo,
        descripcion: cambios.descripcion ?? e.descripcion,
        avisoHora:   cambios.avisoHora   ?? e.avisoHora,
      };
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.sheets.sheetId,
        range: EVENTOS_SHEET + '!A' + e._rowIndex + ':F' + e._rowIndex,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[updated.id, updated.fecha, updated.hora, updated.tipo, updated.descripcion, updated.avisoHora]] },
      });
      logger.info({ eventoId, cambios }, 'Evento editado');
      return { ...updated, _rowIndex: e._rowIndex };
    }
  }
  return null;
}

// Elimina un evento por ID
export async function eliminarEvento(eventoId) {
  const sheets  = await getSheetsClient();
  const rows    = await getAllEventos();
  for (let i = 0; i < rows.length; i++) {
    const e = rowToEvento(rows[i], i);
    if (parseInt(e.id) === parseInt(eventoId)) {
      const meta    = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
      const sheet   = meta.data.sheets.find(s => s.properties.title === EVENTOS_SHEET);
      const sheetId = sheet.properties.sheetId;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.sheets.sheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: { sheetId, dimension: 'ROWS', startIndex: e._rowIndex - 1, endIndex: e._rowIndex },
            },
          }],
        },
      });
      logger.info({ eventoId }, 'Evento eliminado');
      return e;
    }
  }
  return null;
}

// ── Hoja Archivos ─────────────────────────────────────────────────────────────
// Columnas: ID | Nombre | Tipo | Archivo | Fecha
// El archivo en si (bytes) vive en el disco del VPS (/app/data/files); aca solo la metadata.

const ARCHIVOS_SHEET = 'Archivos';
const ARCHIVOS_RANGE = 'A:E';

async function getAllArchivos() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: ARCHIVOS_SHEET + '!' + ARCHIVOS_RANGE,
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return [];
  return rows.slice(1);
}

function rowToArchivo(row) {
  return {
    id:       row[0] ?? '',
    nombre:   row[1] ?? '',
    tipo:     row[2] ?? '',
    archivo:  row[3] ?? '',
    fecha:    row[4] ?? '',
  };
}

async function getNextArchivoId() {
  const rows = await getAllArchivos();
  if (rows.length === 0) return 1;
  const ids = rows.map(r => parseInt(r[0])).filter(n => !isNaN(n));
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

// Registra un archivo nuevo (data.archivo = nombre del archivo en disco, ej "3.jpg")
export async function appendArchivo(data) {
  const sheets = await getSheetsClient();
  const id     = await getNextArchivoId();
  const fecha  = nowAR().fecha;
  const row    = [id, data.nombre, data.tipo, data.archivo, fecha];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.sheetId,
    range: ARCHIVOS_SHEET + '!' + ARCHIVOS_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  logger.info({ id, row }, 'Archivo registrado');
  return id;
}

// Busca archivos por texto en el nombre (case-insensitive, substring)
export async function buscarArchivos(busqueda) {
  const rows   = await getAllArchivos();
  const needle = busqueda.toLowerCase();
  return rows.map(rowToArchivo).filter(a => a.nombre.toLowerCase().includes(needle));
}

// Devuelve todos los archivos guardados
export async function getArchivos() {
  const rows = await getAllArchivos();
  return rows.map(rowToArchivo);
}

// Crea la hoja Archivos (si no existe) y sus headers
export async function ensureArchivosHeaders() {
  const sheets = await getSheetsClient();
  try {
    const meta  = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
    const sheet = meta.data.sheets.find(s => s.properties.title === ARCHIVOS_SHEET);

    if (!sheet) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.sheets.sheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: ARCHIVOS_SHEET } } }] },
      });
      logger.info('Hoja Archivos creada');
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheets.sheetId,
      range: ARCHIVOS_SHEET + '!A1:E1',
    });
    const existing = res.data.values?.[0];
    if (existing && existing.length > 0) return;

    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheets.sheetId,
      range: ARCHIVOS_SHEET + '!A1:E1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['ID', 'Nombre', 'Tipo', 'Archivo', 'Fecha']] },
    });
    logger.info('Headers de Archivos creados');
  } catch (err) {
    logger.warn({ err: err.message }, 'No se pudieron crear/migrar headers de Archivos');
  }
}

// Devuelve el total gastado hoy en ARS (para alerta diaria de personalidad)
export async function getTotalHoyARS() {
  const rows     = await getAllRows();
  const filtered = filterByPeriod(rows.map(rowToObject), 'hoy');
  return filtered
    .filter(r => (r.divisa || 'ARS').toUpperCase() === 'ARS')
    .reduce((sum, r) => sum + (parseFloat(r.monto) || 0), 0);
}

// ── Ayuda por periodo arbitrario ──────────────────────────────────────────────
// Igual que getMonthlyAyuda pero acepta cualquier periodo del sistema
// periodo: 'hoy' | 'ayer' | 'anteayer' | 'dia_semana' | 'semana' | 'mes' | 'mes_especifico'
// opciones: { mesNumero, anio, fechaEspecifica }

export async function getAyudaByPeriod(periodo, opciones = {}) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: 'Ayuda!A:F',
  });

  const rows = (res.data.values || []).slice(1);
  const ar   = nowAR();
  const { mesNumero, anio, fechaEspecifica } = opciones;

  const filtered = rows.filter(r => {
    const fecha = parseDate(r[1]);
    if (!fecha) return false;

    if (periodo === 'mes_especifico' && mesNumero != null && anio != null) {
      return fecha.getMonth() === mesNumero - 1 && fecha.getFullYear() === anio;
    }
    if (periodo === 'mes') {
      return fecha.getMonth() === ar.month - 1 && fecha.getFullYear() === ar.year;
    }
    if (periodo === 'semana') {
      return fecha >= getStartOfWeek() && fecha <= ar._raw;
    }
    if (periodo === 'hoy') {
      return fecha.toDateString() === ar.dateOnly.toDateString();
    }
    if (periodo === 'ayer') {
      const ayer = new Date(ar.dateOnly);
      ayer.setDate(ar.dateOnly.getDate() - 1);
      return fecha.toDateString() === ayer.toDateString();
    }
    if (periodo === 'anteayer') {
      const anteayer = new Date(ar.dateOnly);
      anteayer.setDate(ar.dateOnly.getDate() - 2);
      return fecha.toDateString() === anteayer.toDateString();
    }
    if (periodo === 'dia_semana' && fechaEspecifica) {
      const target = parseDate(fechaEspecifica);
      if (!target) return false;
      return fecha.toDateString() === target.toDateString();
    }
    return false;
  });

  const porOrigen = {};
  let total = 0;
  for (const r of filtered) {
    const origen = r[3] || 'Desconocido';
    const monto  = parseFloat(r[2]) || 0;
    const divisa = (r[5] || 'ARS').toUpperCase();
    const key    = origen + (divisa === 'USD' ? ' (USD)' : '');
    porOrigen[key] = (porOrigen[key] || 0) + monto;
    total += monto;
  }

  return { porOrigen, total, count: filtered.length };
}

// ── Breakdown por categoria para cualquier periodo ────────────────────────────
// Versión generalizada de getMonthlyCategoryBreakdownConDivisa
// Acepta cualquier periodo del sistema incluyendo hoy/ayer/semana/etc.

export async function getCategoryBreakdownByPeriod(periodo, opciones = {}) {
  const rows = await getAllRows();
  const { mesNumero, anio, fechaEspecifica } = opciones;
  let filtered;

  if (periodo === 'mes_especifico' && mesNumero != null && anio != null) {
    filtered = rows.map(rowToObject).filter(r => {
      if (r.tipo !== 'gasto') return false;
      const fecha = parseDate(r.fecha);
      if (!fecha) return false;
      return fecha.getMonth() === mesNumero - 1 && fecha.getFullYear() === anio;
    });
  } else if (periodo === 'mes_detalle' || periodo === 'mes') {
    filtered = filterByPeriod(rows.map(rowToObject), 'mes');
  } else if (periodo === 'mes_detalle_especifico' && mesNumero != null && anio != null) {
    filtered = rows.map(rowToObject).filter(r => {
      if (r.tipo !== 'gasto') return false;
      const fecha = parseDate(r.fecha);
      if (!fecha) return false;
      return fecha.getMonth() === mesNumero - 1 && fecha.getFullYear() === anio;
    });
  } else {
    filtered = filterByPeriod(rows.map(rowToObject), periodo, { fechaEspecifica });
  }

  const breakdownARS = {};
  const breakdownUSD = {};
  for (const cat of CATEGORIAS) { breakdownARS[cat] = 0; breakdownUSD[cat] = 0; }

  for (const r of filtered) {
    const cat    = CATEGORIAS.includes(r.categoria) ? r.categoria : 'otros';
    const monto  = parseFloat(r.monto) || 0;
    const divisa = (r.divisa || 'ARS').toUpperCase();
    if (divisa === 'USD') breakdownUSD[cat] += monto;
    else breakdownARS[cat] += monto;
  }

  const totalARS = Object.values(breakdownARS).reduce((a, b) => a + b, 0);
  const totalUSD = Object.values(breakdownUSD).reduce((a, b) => a + b, 0);

  return { breakdownARS, breakdownUSD, totalARS, totalUSD, count: filtered.length };
}
