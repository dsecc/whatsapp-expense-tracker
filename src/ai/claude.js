import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// ── Personalidad base ────────────────────────────────────────────────────────
const PERSONALIDAD_BASE = `Adam Smith, asistente financiero porteño. Voseo, directo, lunfardo natural, nunca formal. Charla sin intención financiera → respondé corto sin forzar registros. Español rioplatense siempre.`;

// ── Herramientas ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'registrar_gasto_ingreso',
    description: 'Registra gasto o ingreso. Usar cuando el usuario mencione que gastó, pagó, compró, cobró, recibió sueldo.',
    input_schema: {
      type: 'object',
      properties: {
        tipo:        { type: 'string', enum: ['gasto','ingreso'] },
        monto:       { type: 'number' },
        categoria:   { type: 'string', enum: ['comida','social','recreacion','transporte','tecnologia','suscripciones','salud','hogar','otros'], description: 'comida=alimentacion(super/delivery/verduleria). social=con otras personas(salida con alguien, cumple, merienda con nombre). recreacion=gusto personal solo(helado, cine, porro). tecnologia=dispositivos/cursos/software. hogar=wifi/ropa/cosas de casa/fijos. Si no queda claro si es social o recreacion, pregunta antes de registrar.' },
        descripcion: { type: 'string' },
        divisa:      { type: 'string', enum: ['ARS','USD'], description: 'USD si menciona dolares/verde/USD' },
      },
      required: ['tipo','monto','categoria','descripcion','divisa'],
    },
  },
  {
    name: 'editar_gasto',
    description: 'Modifica gasto ya registrado. Usar cuando algo estaba mal, era otro monto, era a medias.',
    input_schema: {
      type: 'object',
      properties: {
        id_referenciado:      { type: 'number', description: 'ID si el usuario lo menciona' },
        descripcion_busqueda: { type: 'string', description: 'Texto para buscar el gasto' },
        usar_ultimo:          { type: 'boolean', description: 'true si dice ese/eso/ese mismo' },
        indice_stack:         { type: 'number', description: '0=ultimo 1=anterior 2=antes del anterior' },
        nuevo_monto:          { type: 'number' },
        nueva_categoria:      { type: 'string' },
        nueva_descripcion:    { type: 'string' },
        nuevo_tipo:           { type: 'string', enum: ['gasto','ingreso'] },
        es_mitad:             { type: 'boolean', description: 'true si dice a medias/mitad/50%' },
      },
      required: ['usar_ultimo'],
    },
  },
  {
    name: 'eliminar_gasto',
    description: 'Elimina uno o varios gastos. Usar cuando diga borra/saca/elimina/al final salio gratis.',
    input_schema: {
      type: 'object',
      properties: {
        id_referenciado:      { type: 'number' },
        ids_referenciados:    { type: 'array', items: { type: 'number' }, description: 'Varios IDs a la vez' },
        descripcion_busqueda: { type: 'string' },
        usar_ultimo:          { type: 'boolean', description: 'true si dice ese/eso/borralo' },
        indice_stack:         { type: 'number', description: '0=ultimo 1=anterior' },
      },
      required: ['usar_ultimo'],
    },
  },
  {
    name: 'ver_resumen',
    description: 'Resumen detallado de gastos por periodo con breakdown por categoria y ayuda recibida.',
    input_schema: {
      type: 'object',
      properties: {
        periodo:          { type: 'string', enum: ['hoy','ayer','anteayer','dia_semana','semana','mes','mes_especifico'] },
        mes_numero:       { type: 'number', description: '1-12 para mes_especifico' },
        anio:             { type: 'number' },
        fecha_especifica: { type: 'string', description: 'dd/mm/yyyy para dia_semana' },
        tipo_cambio:      { type: 'number', description: 'ARS por USD si el usuario lo menciona' },
      },
      required: ['periodo'],
    },
  },
  {
    name: 'registrar_ayuda',
    description: 'Registra dinero que alguien le dio al usuario (regalo, transferencia familiar). NO es prestamo.',
    input_schema: {
      type: 'object',
      properties: {
        monto:       { type: 'number' },
        de_quien:    { type: 'string' },
        descripcion: { type: 'string' },
        divisa:      { type: 'string', enum: ['ARS','USD'] },
      },
      required: ['monto','de_quien','descripcion','divisa'],
    },
  },
  {
    name: 'ver_resumen_ayuda',
    description: 'Muestra ayuda economica recibida este mes.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'registrar_deuda',
    description: 'Registra prestamo que alguien le hizo al usuario. Usar con: me presto, le debo a, me fiaron.',
    input_schema: {
      type: 'object',
      properties: {
        acreedor:    { type: 'string' },
        monto:       { type: 'number' },
        descripcion: { type: 'string' },
        divisa:      { type: 'string', enum: ['ARS','USD'] },
      },
      required: ['acreedor','monto','descripcion','divisa'],
    },
  },
  {
    name: 'sumar_deuda',
    description: 'Suma monto a deuda existente. Usar con: otros X, sumarle mas, me fio otros.',
    input_schema: {
      type: 'object',
      properties: {
        acreedor:        { type: 'string' },
        monto_adicional: { type: 'number' },
        divisa:          { type: 'string', enum: ['ARS','USD'] },
      },
      required: ['acreedor','monto_adicional','divisa'],
    },
  },
  {
    name: 'pagar_deuda',
    description: 'Registra pago de una deuda existente.',
    input_schema: {
      type: 'object',
      properties: {
        acreedor:   { type: 'string' },
        monto_pago: { type: 'number' },
      },
      required: ['acreedor','monto_pago'],
    },
  },
  {
    name: 'ver_resumen_deudas',
    description: 'Muestra deudas pendientes.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'borrar_deudas_saldadas',
    description: 'Borra solo deudas ya saldadas.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'borrar_todas_deudas',
    description: 'Borra TODAS las deudas. Requiere confirmacion.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'registrar_suscripcion',
    description: 'Registra suscripcion nueva paga o prueba gratis.',
    input_schema: {
      type: 'object',
      properties: {
        nombre:          { type: 'string' },
        monto:           { type: 'number', description: '0 si es prueba' },
        dia:             { type: 'number', description: 'Dia del mes, 0 si es prueba' },
        tipo:            { type: 'string', enum: ['paga','prueba'] },
        fecha_fin_prueba:{ type: 'string', description: 'dd/mm/yyyy si es prueba' },
        divisa:          { type: 'string', enum: ['ARS','USD'] },
      },
      required: ['nombre','tipo','divisa'],
    },
  },
  {
    name: 'cancelar_suscripcion',
    description: 'Marca suscripcion como cancelada sin borrarla.',
    input_schema: {
      type: 'object',
      properties: { nombre: { type: 'string' } },
      required: ['nombre'],
    },
  },
  {
    name: 'editar_suscripcion',
    description: 'Modifica datos de una suscripcion (monto, dia, divisa, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        nombre:          { type: 'string', description: 'Nombre actual' },
        nuevo_nombre:    { type: 'string' },
        nuevo_monto:     { type: 'number' },
        nuevo_dia:       { type: 'number' },
        nueva_divisa:    { type: 'string', enum: ['ARS','USD'] },
        nuevo_tipo:      { type: 'string', enum: ['paga','prueba'] },
        nueva_fecha_fin: { type: 'string' },
      },
      required: ['nombre'],
    },
  },
  {
    name: 'eliminar_suscripcion',
    description: 'Elimina definitivamente una suscripcion del registro.',
    input_schema: {
      type: 'object',
      properties: { nombre: { type: 'string' } },
      required: ['nombre'],
    },
  },
  {
    name: 'ver_suscripciones',
    description: 'Lista suscripciones activas.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'snooze_suscripcion',
    description: 'Posterga recordatorio de una suscripcion.',
    input_schema: {
      type: 'object',
      properties: { nombre: { type: 'string' } },
      required: ['nombre'],
    },
  },
  {
    name: 'ver_reporte_mensual',
    description: 'Reporte completo del mes anterior.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'registrar_evento',
    description: 'Registra un evento, turno, examen, reunion o recordatorio futuro. Usar cuando el usuario diga: tengo turno, tengo examen, tengo reunion, recordame que el dia X tengo Y, el lunes tengo, anota que el X tengo. La fecha siempre en dd/mm/yyyy usando la fecha actual como referencia para calcular dias relativos (mañana, el jueves, la semana que viene, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        fecha:       { type: 'string', description: 'dd/mm/yyyy obligatorio' },
        hora:        { type: 'string', description: 'HH:MM opcional. Si dice "a las 10" → "10:00"' },
        tipo:        { type: 'string', description: 'turno | examen | reunion | social | pago | recordatorio | evento | otro. Inferir del contexto: turno=médico/trámite, examen=parcial/final/certificación, reunion=laboral/call, social=cumpleaños/salida/cena con gente, pago=vencimiento/cuota que no es suscripción, recordatorio=cualquier otra cosa a no olvidar.' },
        descripcion: { type: 'string', description: 'Descripcion corta y clara del evento. Ej: "médico clínico", "examen de análisis matemático", "reunión con el cliente"' },
        aviso_hora:  { type: 'string', description: 'HH:MM en que se envia el aviso el mismo dia del evento. Si el usuario ya dijo en el mensaje cuando avisarle (ej "avisame una hora antes", "avisame a las 9") calcular el HH:MM y ponerlo aca directo, sin preguntar. Si NO lo dijo, NO llamar esta tool todavia: preguntarle primero si queres que te avise a las 8am (default) o antes del evento (o a que hora si el evento no tiene hora), y recien con la respuesta llamar registrar_evento con este campo resuelto.' },
      },
      required: ['fecha', 'descripcion'],
    },
  },
  {
    name: 'ver_eventos',
    description: 'Muestra los eventos y turnos futuros registrados. Usar cuando el usuario diga: qué eventos tengo, mis turnos, qué tengo pendiente, tengo algo esta semana, algo mañana, mis recordatorios.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'editar_evento',
    description: 'Modifica un evento ya registrado. Usar cuando diga: cambiá el turno para el dia X, la reunión es a las Y, corregí la fecha, el examen lo corrí, el turno del médico lo moví, cambió el horario, avisame antes/despues, cambiá el aviso, avisame a las Y ese dia. Buscar por descripcion o por #ID.',
    input_schema: {
      type: 'object',
      properties: {
        id:               { type: 'number', description: 'ID del evento si el usuario lo menciona con #N' },
        descripcion_busqueda: { type: 'string', description: 'Texto para encontrar el evento a editar' },
        nueva_fecha:      { type: 'string', description: 'Nueva fecha dd/mm/yyyy si cambia' },
        nueva_hora:       { type: 'string', description: 'Nueva hora HH:MM si cambia' },
        nuevo_tipo:       { type: 'string', description: 'Nuevo tipo si cambia' },
        nueva_descripcion:{ type: 'string', description: 'Nueva descripcion si cambia' },
        nueva_aviso_hora: { type: 'string', description: 'Nueva hora HH:MM de aviso el mismo dia, si el usuario quiere cambiar cuando le avisan (ej "avisame 2 horas antes", "avisame a las 7")' },
      },
    },
  },
  {
    name: 'eliminar_evento',
    description: 'Elimina o cancela un evento. Usar cuando diga: borra el turno, cancela el examen, ya no tengo reunión, lo cancelé, no voy más, eliminá el evento #N, me dieron de baja el turno.',
    input_schema: {
      type: 'object',
      properties: {
        id:          { type: 'number', description: 'ID del evento si el usuario menciona #N' },
        descripcion: { type: 'string', description: 'Texto para buscar el evento a eliminar' },
      },
    },
  },
  {
    name: 'guardar_archivo',
    description: 'Guarda una imagen o PDF que el usuario acaba de enviar, para poder mandarselo de nuevo cuando lo pida despues (entradas, comprobantes, examenes, capturas, etc). Usar cuando el mensaje trae una imagen/PDF adjunto y: (a) el usuario dice explicitamente que es algo para guardar (ej "guarda esto como entrada de la ecoparty", "esta es la entrada de X", "anota este comprobante"), o (b) la imagen claramente NO es una invitacion/turno con fecha para registrar como evento (es una entrada, ticket, comprobante, foto de examen, etc) y el usuario ya confirmo que la guarde. Si no hay imagen/PDF pendiente en la conversacion, no usar esta tool.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre o tag corto para poder buscarlo despues. Ej: "entrada ecoparty", "comprobante turno medico", "examen matematica". Si el usuario no dijo como llamarlo, preguntarle antes de usar esta tool.' },
      },
      required: ['nombre'],
    },
  },
  {
    name: 'enviar_archivo',
    description: 'Busca un archivo guardado anteriormente (entrada, comprobante, foto, PDF) y lo reenvia. Usar cuando el usuario diga: mandame la entrada de X, pasame el comprobante de Y, tenes el pdf del examen, buscame la foto de Z.',
    input_schema: {
      type: 'object',
      properties: {
        busqueda: { type: 'string', description: 'Texto para buscar por nombre entre los archivos guardados' },
      },
      required: ['busqueda'],
    },
  },
  {
    name: 'listar_archivos',
    description: 'Lista los archivos guardados. Usar cuando pregunte que archivos tiene guardados, que entradas/comprobantes tiene, etc.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'registrar_recordatorio',
    description: 'Registra un recordatorio para una fecha. Usar cuando el usuario diga: recordame, anotame que tengo que, acordame, no me olvides, tengo que hacer, necesito hacer, el lunes tengo que.',
    input_schema: {
      type: 'object',
      properties: {
        fecha:       { type: 'string', description: 'dd/mm/yyyy. Calcular desde fecha actual para referencias relativas (mañana, el jueves, etc.)' },
        hora:        { type: 'string', description: 'HH:MM opcional. Si no especifica, se avisa a las 8:00 de ese dia' },
        descripcion: { type: 'string', description: 'Descripcion corta de lo que hay que recordar. Ej: "entregar informe", "llamar al médico", "pagar cuota"' },
      },
      required: ['fecha', 'descripcion'],
    },
  },
  {
    name: 'ver_recordatorios',
    description: 'Muestra recordatorios pendientes. Usar cuando diga: qué recordatorios tengo, mis pendientes, qué tengo que hacer, qué me falta.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'snooze_recordatorio',
    description: 'Posterga un recordatorio por N horas desde ahora. Usar cuando diga: snooze, recordamelo en X horas, avisame más tarde, en X horas me acordás.',
    input_schema: {
      type: 'object',
      properties: {
        id:                   { type: 'number', description: 'ID si el usuario lo menciona con #N' },
        descripcion_busqueda: { type: 'string', description: 'Texto para encontrar el recordatorio' },
        horas:                { type: 'number', description: 'Horas a postergar desde ahora' },
      },
      required: ['horas'],
    },
  },
  {
    name: 'eliminar_recordatorio',
    description: 'Elimina un recordatorio. Usar cuando diga: borra el recordatorio, cancelá ese recordatorio, ya no hace falta.',
    input_schema: {
      type: 'object',
      properties: {
        id:                   { type: 'number', description: 'ID numerico. Si dice "el 1", "el #2", "#3" → extraer el numero como id' },
        descripcion_busqueda: { type: 'string', description: 'Texto para buscar por descripcion' },
      },
    },
  },
  {
    name: 'confirmar_accion',
    description: 'Usuario confirma accion pendiente: si/dale/va/ok/correcto/eso.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'rechazar_accion',
    description: 'Usuario cancela accion pendiente: no/cancela/nope.',
    input_schema: { type: 'object', properties: {} },
  },
];

// ── Palabras clave que indican que Claude necesita ver filas recientes ────────
const KEYWORDS_NECESITAN_FILAS = [
  'ese','eso','ese mismo','el mismo','borra','borralo','elimina','edita','cambia',
  'anterior','el de antes','el otro','modifica','era','eran','no era','salio gratis',
  'a medias','mitad','el #','#1','#2','#3','#4','#5','#6','#7','#8','#9',
];

const KEYWORDS_NECESITAN_RECORDATORIOS = [
  'recordatorio','ese recordatorio','el recordatorio','borra el recordatorio',
  'elimina el recordatorio','mis recordatorios','recordatorios',
];

function necesitaFilas(body) {
  const lower = body.toLowerCase();
  return KEYWORDS_NECESITAN_FILAS.some(kw => lower.includes(kw));
}

function necesitaRecordatorios(body) {
  const lower = body.toLowerCase();
  return KEYWORDS_NECESITAN_RECORDATORIOS.some(kw => lower.includes(kw));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatHistorial(history) {
  if (!history || history.length === 0) return '';
  return history.slice(-3).map(h => '[' + (h.role === 'user' ? 'U' : 'B') + ']: ' + h.text).join('\n');
}

function formatStack(stack) {
  if (!stack || stack.length === 0) return '(ninguna)';
  return stack.slice().reverse()
    .map((s, i) => '[' + i + '] #' + s.rowObject.id + ' | ' + s.rowObject.fecha + ' | ' + s.rowObject.tipo + ' | $' + s.rowObject.monto + ' | ' + s.rowObject.categoria + ' | ' + s.rowObject.detalle)
    .join('\n');
}

function formatFilas(rows) {
  if (!rows || rows.length === 0) return '';
  return rows.map(r => '#' + r.id + ' | ' + r.fecha + ' | ' + r.tipo + ' | $' + r.monto + ' | ' + r.categoria + ' | ' + r.detalle).join('\n');
}

function fechaHoyAR() {
  const fmt = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return parts.weekday + ' ' + parts.day + '/' + parts.month + '/' + parts.year;
}

// ── Bloque estatico cacheado (personalidad + reglas) ─────────────────────────
// Se construye una vez. Las tools se pasan separadas con cache_control.
const STATIC_SYSTEM_TEXT = PERSONALIDAD_BASE +
  '\n\nREGLAS: ese/eso/borralo→usar_ultimo:true idx:0 | anterior→idx:1 | dia semana→dd/mm/yyyy mas reciente pasado | charla→texto directo sin herramienta | social=con otra persona, recreacion=solo/gusto personal — si no queda claro pregunta antes de registrar | registrar_evento: si el usuario no especifico cuando avisarle, preguntar antes de llamar la tool si quiere aviso a las 8am o antes del evento (o a que hora, si no tiene hora) — no asumir 8am en silencio | imagen adjunta: si parece invitacion/turno/flyer con fecha → tratarla como evento (registrar_evento, con la misma regla de preguntar el aviso). Si parece entrada/ticket/comprobante/examen/captura sin fecha de evento → es un archivo para guardar (guardar_archivo), preguntando el nombre si no vino en el mensaje. Si no queda claro cual de las dos es, preguntar directo antes de elegir. PDF adjunto sin imagen → siempre tratarlo como archivo para guardar, nunca como evento';

const AUDIO_SYSTEM_TEXT = `AUDIO TRANSCRIPTO — reglas especiales:
Este texto fue dictado y puede contener múltiples órdenes seguidas. Identificá cada intención y ejecutá una tool por cada una. No pidas confirmación entre órdenes del mismo audio — ejecutá todo y respondé con los resultados.

Patrones de habla a reconocer:
- "X en Y" sin verbo → gasto de X en categoría Y. Ej: "doscientos en nafta" = gasto $200 transporte, "quinientos en el super" = gasto $500 comida
- "y X en Y" / "también X" → otro gasto encadenado, igual al anterior
- Monto sin divisa → ARS siempre
- Números en palabras → convertir: quinientos=500, doscientos=200, mil=1000, cien=100, cincuenta=50, "mil quinientos"=1500
- "acordame / recordame [el dia] [descripcion]" → registrar_recordatorio o registrar_evento según contexto
- Horas habladas: "diez y media"=10:30, "tres de la tarde"=15:00, "mediodía"=12:00, "ocho y cuarto"=08:15
- Ignorar muletillas: "che", "bue", "tipo", "o sea", "dale", "nada"

Operaciones sobre registros existentes:
- "elimina / borra lo de X" → eliminar con descripcion_busqueda inferida. Ej: "lo de la nafta" → descripcion_busqueda:"nafta", "lo del super" → descripcion_busqueda:"supermercado"
- "el último gasto / evento / recordatorio" → usar_ultimo:true
- "cambiá / modificá X" → tool de editar con descripcion_busqueda
- El tipo de registro lo inferís del contexto: "turno/médico/doctor" → evento, "nafta/super/delivery/café" → gasto
- Solo preguntá si hay ambigüedad real que no podés resolver con el contexto`;

// ── Funcion principal ─────────────────────────────────────────────────────────
// image opcional: { base64, mediaType } — se adjunta como bloque de vision (solo imagenes, no PDF)
// isAudio: true cuando el body viene de una transcripcion de audio
export { necesitaRecordatorios };

export async function processMessage(body, history, recentRows, interactedStack, image, isAudio = false, pendingRecordatorios = []) {
  const incluirFilas = isAudio || necesitaFilas(body);
  const filasStr     = incluirFilas ? formatFilas(recentRows) : '';
  const historialStr = formatHistorial(history);
  const stackStr     = formatStack(interactedStack);

  // Parte dinamica: fecha + contexto variable por mensaje
  let dinamico = 'Fecha (Argentina): ' + fechaHoyAR();

  if (incluirFilas) {
    dinamico += '\n\nInteractuadas (0=reciente):\n' + stackStr;
    dinamico += '\n\nRegistros recientes:\n' + filasStr;
  } else if (interactedStack && interactedStack.length > 0) {
    const last = interactedStack[interactedStack.length - 1];
    dinamico += '\n\nUltimo: #' + last.rowObject.id + ' ' + last.rowObject.detalle + ' $' + last.rowObject.monto;
  }

  if (pendingRecordatorios.length > 0) {
    dinamico += '\n\nRecordatorios pendientes:\n' +
      pendingRecordatorios.map(r => '#' + r.id + ' | ' + r.fecha + (r.hora ? ' ' + r.hora : '') + ' | ' + r.descripcion).join('\n');
  }

  if (historialStr) {
    dinamico += '\n\nHistorial:\n' + historialStr;
  }

  const systemBlocks = [
    {
      type: 'text',
      text: STATIC_SYSTEM_TEXT,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: dinamico + (isAudio ? '\n\n' + AUDIO_SYSTEM_TEXT : ''),
    },
  ];

  // Tools tambien con cache_control en la ultima herramienta
  // Esto cachea el bloque completo de tools junto con el system
  const toolsConCache = TOOLS.map((t, i) =>
    i === TOOLS.length - 1
      ? { ...t, cache_control: { type: 'ephemeral' } }
      : t
  );

  const userContent = image
    ? [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
        { type: 'text', text: body },
      ]
    : body;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: isAudio ? 2048 : 512,
      system: systemBlocks,
      tools: toolsConCache,
      messages: [{ role: 'user', content: userContent }],
    });

    const inputT       = response.usage?.input_tokens              || 0;
    const outputT      = response.usage?.output_tokens             || 0;
    const cacheWrite   = response.usage?.cache_creation_input_tokens || 0;
    const cacheRead    = response.usage?.cache_read_input_tokens     || 0;
    const cacheHit     = cacheRead > 0;
    logger.info({
      stopReason:      response.stop_reason,
      input_tokens:    inputT,
      output_tokens:   outputT,
      total_tokens:    inputT + outputT,
      cache_write:     cacheWrite,
      cache_read:      cacheRead,
      cache_hit:       cacheHit,
      filas_incluidas: incluirFilas,
      is_audio:        isAudio,
    }, 'Claude usage');

    const toolUses = [];
    let textResp   = null;
    for (const block of response.content) {
      if (block.type === 'tool_use') toolUses.push(block);
      if (block.type === 'text')     textResp = block.text;
    }

    return { toolUses, textResp };

  } catch (err) {
    logger.error({ err }, 'Error en processMessage');
    return { toolUse: null, textResp: 'Uy, algo explotó. Intentalo de nuevo.' };
  }
}
