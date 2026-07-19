import { google } from 'googleapis';
import dotenv from 'dotenv';
dotenv.config();

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_KEY   = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);

// ── Paleta minimalista azul-blanca ───────────────────────────────────────────
// 12 variaciones de azul muy suave para los meses (todas en familia azul-blanco)
const MONTH_COLORS = [
  { r: 0.929, g: 0.949, b: 1.000 }, // enero     #EDF2FF
  { r: 0.886, g: 0.933, b: 1.000 }, // febrero   #E2EDFF
  { r: 0.937, g: 0.961, b: 1.000 }, // marzo     #EFF5FF
  { r: 0.875, g: 0.925, b: 1.000 }, // abril     #DFECFF
  { r: 0.945, g: 0.965, b: 1.000 }, // mayo      #F1F6FF
  { r: 0.855, g: 0.918, b: 1.000 }, // junio     #DAEBFF
  { r: 0.953, g: 0.969, b: 1.000 }, // julio     #F3F7FF
  { r: 0.910, g: 0.941, b: 1.000 }, // agosto    #E8F0FF
  { r: 0.918, g: 0.953, b: 1.000 }, // sept      #EAF3FF
  { r: 0.863, g: 0.910, b: 1.000 }, // octubre   #DBE8FF
  { r: 0.941, g: 0.969, b: 1.000 }, // noviembre #F0F7FF
  { r: 0.898, g: 0.929, b: 1.000 }, // diciembre #E5EDFF
];

// Headers por hoja: todos oscuros navy/charcoal
const SHEET_CONFIG = {
  Gastos:        { hdr: { r: 0.11, g: 0.15, b: 0.28 }, cols: 9  },
  Ayuda:         { hdr: { r: 0.13, g: 0.13, b: 0.25 }, cols: 6  },
  Deudas:        { hdr: { r: 0.13, g: 0.13, b: 0.25 }, cols: 9  }, // A:I con Divisa
  Suscripciones: { hdr: { r: 0.13, g: 0.13, b: 0.25 }, cols: 10 }, // A:J con Divisa
  Eventos:       { hdr: { r: 0.13, g: 0.13, b: 0.25 }, cols: 5  },
};

// Anchos de columna en px (A, B, C ...)
const COL_WIDTHS = {
  Gastos:        [45, 90, 55, 60, 75, 105, 250, 65, 55],
  Ayuda:         [45, 90, 80, 130, 250, 55],
  Deudas:        [45, 90, 145, 90, 90, 80, 80, 250, 55],
  Suscripciones: [45, 165, 80, 50, 85, 110, 80, 115, 80, 55],
  Eventos:       [45, 90, 55, 90, 290],
};

// ── Helpers de color ─────────────────────────────────────────────────────────
function rgb(r, g, b) { return { red: r, green: g, blue: b, alpha: 1 }; }
function c(obj)       { return rgb(obj.r, obj.g, obj.b); }

function parseMonth(dateStr) {
  const p = (dateStr || '').split('/');
  if (p.length < 3) return null;
  const m = parseInt(p[1]) - 1;
  return (m >= 0 && m <= 11) ? m : null;
}

// ── Request builders ─────────────────────────────────────────────────────────
function reqFreezeHeader(sheetId) {
  return {
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  };
}

function reqHeaderFormat(sheetId, cols, hdrColor) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: cols },
      cell: {
        userEnteredFormat: {
          backgroundColor: c(hdrColor),
          textFormat: { foregroundColor: rgb(1, 1, 1), bold: true, fontSize: 10 },
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'CLIP',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
    },
  };
}

function reqRowHeight(sheetId, startRow, endRow, px) {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: startRow, endIndex: endRow },
      properties: { pixelSize: px },
      fields: 'pixelSize',
    },
  };
}

function reqRowBg(sheetId, rowIdx, cols, bgColor) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: cols },
      cell: { userEnteredFormat: { backgroundColor: c(bgColor) } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  };
}

function reqCellText(sheetId, rowIdx, colIdx, textColor, bold = true) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: colIdx, endColumnIndex: colIdx + 1 },
      cell: { userEnteredFormat: { textFormat: { foregroundColor: c(textColor), bold } } },
      fields: 'userEnteredFormat.textFormat',
    },
  };
}

function reqColWidth(sheetId, colIdx, px) {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: colIdx, endIndex: colIdx + 1 },
      properties: { pixelSize: px },
      fields: 'pixelSize',
    },
  };
}

function reqAutoFilter(sheetId, totalRows, cols) {
  return {
    setBasicFilter: {
      filter: {
        range: { sheetId, startRowIndex: 0, endRowIndex: totalRows, startColumnIndex: 0, endColumnIndex: cols },
      },
    },
  };
}

function reqBorders(sheetId, totalRows, cols) {
  const thin = { style: 'SOLID', width: 1, color: rgb(0.82, 0.87, 0.95) };
  return {
    updateBorders: {
      range: { sheetId, startRowIndex: 0, endRowIndex: totalRows, startColumnIndex: 0, endColumnIndex: cols },
      top: thin, bottom: thin, left: thin, right: thin,
      innerHorizontal: thin, innerVertical: thin,
    },
  };
}

// ── Formateo por hoja ────────────────────────────────────────────────────────

function buildGastos(sheetId, rows) {
  const { hdr, cols } = SHEET_CONFIG.Gastos;
  const reqs = [];

  reqs.push(reqFreezeHeader(sheetId));
  reqs.push(reqHeaderFormat(sheetId, cols, hdr));
  reqs.push(reqRowHeight(sheetId, 0, 1, 30));   // header más alto
  reqs.push(reqRowHeight(sheetId, 1, Math.max(rows.length, 2), 20));

  for (let i = 1; i < rows.length; i++) {
    const tipo  = (rows[i][3] || '').toLowerCase();
    const month = parseMonth(rows[i][1]);

    // Ingreso → verde suave; gasto → color de mes
    const bg = tipo === 'ingreso'
      ? { r: 0.88, g: 0.96, b: 0.90 }
      : (month !== null ? MONTH_COLORS[month] : { r: 0.97, g: 0.97, b: 0.99 });

    reqs.push(reqRowBg(sheetId, i, cols, bg));

    // Tipo en bold coloreado (texto, no fondo)
    const tipoColor = tipo === 'ingreso'
      ? { r: 0.10, g: 0.48, b: 0.22 }
      : { r: 0.60, g: 0.10, b: 0.10 };
    reqs.push(reqCellText(sheetId, i, 3, tipoColor));
  }

  COL_WIDTHS.Gastos.forEach((px, col) => reqs.push(reqColWidth(sheetId, col, px)));
  reqs.push(reqAutoFilter(sheetId, rows.length, cols));
  reqs.push(reqBorders(sheetId, rows.length, cols));
  return reqs;
}

function buildAyuda(sheetId, rows) {
  const { hdr, cols } = SHEET_CONFIG.Ayuda;
  const reqs = [];

  reqs.push(reqFreezeHeader(sheetId));
  reqs.push(reqHeaderFormat(sheetId, cols, hdr));
  reqs.push(reqRowHeight(sheetId, 0, 1, 30));
  reqs.push(reqRowHeight(sheetId, 1, Math.max(rows.length, 2), 20));

  for (let i = 1; i < rows.length; i++) {
    const month = parseMonth(rows[i][1]);
    const bg = month !== null ? MONTH_COLORS[month] : { r: 0.97, g: 0.97, b: 0.99 };
    reqs.push(reqRowBg(sheetId, i, cols, bg));
    reqs.push(reqCellText(sheetId, i, 3, { r: 0.15, g: 0.20, b: 0.45 })); // De quien bold
  }

  COL_WIDTHS.Ayuda.forEach((px, col) => reqs.push(reqColWidth(sheetId, col, px)));
  reqs.push(reqAutoFilter(sheetId, rows.length, cols));
  reqs.push(reqBorders(sheetId, rows.length, cols));
  return reqs;
}

function buildDeudas(sheetId, rows) {
  const { hdr, cols } = SHEET_CONFIG.Deudas;
  const reqs = [];

  reqs.push(reqFreezeHeader(sheetId));
  reqs.push(reqHeaderFormat(sheetId, cols, hdr));
  reqs.push(reqRowHeight(sheetId, 0, 1, 30));
  reqs.push(reqRowHeight(sheetId, 1, Math.max(rows.length, 2), 20));

  for (let i = 1; i < rows.length; i++) {
    const estado = (rows[i][6] || '').toLowerCase();
    const bg = estado === 'saldada'
      ? { r: 0.89, g: 0.97, b: 0.91 }  // verde suave
      : { r: 1.00, g: 0.96, b: 0.88 }; // naranja muy suave
    const estadoColor = estado === 'saldada'
      ? { r: 0.10, g: 0.48, b: 0.22 }
      : { r: 0.68, g: 0.38, b: 0.00 };

    reqs.push(reqRowBg(sheetId, i, cols, bg));
    reqs.push(reqCellText(sheetId, i, 6, estadoColor)); // col G Estado
  }

  COL_WIDTHS.Deudas.forEach((px, col) => reqs.push(reqColWidth(sheetId, col, px)));
  reqs.push(reqAutoFilter(sheetId, rows.length, cols));
  reqs.push(reqBorders(sheetId, rows.length, cols));
  return reqs;
}

function buildSuscripciones(sheetId, rows) {
  const { hdr, cols } = SHEET_CONFIG.Suscripciones;
  const reqs = [];

  reqs.push(reqFreezeHeader(sheetId));
  reqs.push(reqHeaderFormat(sheetId, cols, hdr));
  reqs.push(reqRowHeight(sheetId, 0, 1, 30));
  reqs.push(reqRowHeight(sheetId, 1, Math.max(rows.length, 2), 20));

  for (let i = 1; i < rows.length; i++) {
    const estado = (rows[i][6] || '').toLowerCase();
    let bg, estadoColor;
    if (estado === 'activa') {
      bg = { r: 0.87, g: 0.97, b: 0.90 };
      estadoColor = { r: 0.10, g: 0.48, b: 0.22 };
    } else if (estado === 'prueba') {
      bg = { r: 1.00, g: 0.97, b: 0.84 };
      estadoColor = { r: 0.62, g: 0.42, b: 0.00 };
    } else {
      bg = { r: 0.93, g: 0.93, b: 0.93 };
      estadoColor = { r: 0.45, g: 0.45, b: 0.45 };
    }

    reqs.push(reqRowBg(sheetId, i, cols, bg));
    reqs.push(reqCellText(sheetId, i, 6, estadoColor));
    reqs.push(reqCellText(sheetId, i, 1, { r: 0.10, g: 0.10, b: 0.10 })); // Nombre bold
  }

  COL_WIDTHS.Suscripciones.forEach((px, col) => reqs.push(reqColWidth(sheetId, col, px)));
  reqs.push(reqAutoFilter(sheetId, rows.length, cols));
  reqs.push(reqBorders(sheetId, rows.length, cols));
  return reqs;
}

function buildEventos(sheetId, rows) {
  const { hdr, cols } = SHEET_CONFIG.Eventos;
  const reqs = [];

  reqs.push(reqFreezeHeader(sheetId));
  reqs.push(reqHeaderFormat(sheetId, cols, hdr));
  reqs.push(reqRowHeight(sheetId, 0, 1, 30));
  reqs.push(reqRowHeight(sheetId, 1, Math.max(rows.length, 2), 20));

  const TIPO_PALETTE = {
    'cumpleaños':   { bg: { r: 1.00, g: 0.88, b: 0.97 }, text: { r: 0.58, g: 0.10, b: 0.48 } },
    'recordatorio': { bg: { r: 0.88, g: 0.95, b: 1.00 }, text: { r: 0.10, g: 0.30, b: 0.65 } },
    'pago':         { bg: { r: 1.00, g: 0.96, b: 0.80 }, text: { r: 0.62, g: 0.38, b: 0.00 } },
  };
  const DEFAULT_PAL = { bg: { r: 0.95, g: 0.97, b: 0.95 }, text: { r: 0.25, g: 0.25, b: 0.25 } };

  for (let i = 1; i < rows.length; i++) {
    const tipo = (rows[i][3] || '').toLowerCase();
    const pal  = TIPO_PALETTE[tipo] || DEFAULT_PAL;
    reqs.push(reqRowBg(sheetId, i, cols, pal.bg));
    reqs.push(reqCellText(sheetId, i, 3, pal.text));
  }

  COL_WIDTHS.Eventos.forEach((px, col) => reqs.push(reqColWidth(sheetId, col, px)));
  reqs.push(reqAutoFilter(sheetId, rows.length, cols));
  reqs.push(reqBorders(sheetId, rows.length, cols));
  return reqs;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: SA_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Obteniendo metadata...');
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMap = {};
  for (const s of meta.data.sheets) sheetMap[s.properties.title] = s.properties.sheetId;

  const BUILDERS = {
    Gastos:        buildGastos,
    Ayuda:         buildAyuda,
    Deudas:        buildDeudas,
    Suscripciones: buildSuscripciones,
    Eventos:       buildEventos,
  };

  const allRequests = [];

  for (const [name, builder] of Object.entries(BUILDERS)) {
    const sheetId = sheetMap[name];
    if (sheetId === undefined) { console.log(`  ⚠ "${name}" no encontrada`); continue; }

    console.log(`Leyendo "${name}"...`);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${name}!A:J`,
    });
    const rows = res.data.values || [];
    console.log(`  ${rows.length} filas`);

    const reqs = builder(sheetId, rows);
    allRequests.push(...reqs);
    console.log(`  ${reqs.length} requests generados`);
  }

  const BATCH = 500;
  console.log(`\nEnviando ${allRequests.length} requests...`);
  for (let i = 0; i < allRequests.length; i += BATCH) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: allRequests.slice(i, i + BATCH) },
    });
    console.log(`  Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(allRequests.length / BATCH)} ok`);
  }

  console.log('\n✓ Listo. Cambios aplicados:');
  console.log('  Gastos:        azul-blanco por mes, ingreso=verde, tipo bold rojo/verde');
  console.log('  Ayuda:         azul-blanco por mes, "De quien" bold');
  console.log('  Deudas:        pendiente=naranja suave, saldada=verde suave (+ Divisa incluida)');
  console.log('  Suscripciones: activa=verde, prueba=amarillo, inactiva=gris (+ Divisa incluida)');
  console.log('  Eventos:       colores por tipo (sin cambios estéticos)');
  console.log('  Todas:         header navy+blanco 30px, bordes azul-gris, filtros, anchos optimizados');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
