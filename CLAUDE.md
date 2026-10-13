# WhatsApp Expense Tracker — Adam Smith

Bot de WhatsApp personal para registro de gastos, deudas, suscripciones, eventos, recordatorios y cumpleaños. Soporta mensajes de texto y audios (transcripción via Whisper). Corre en Docker sobre un VPS propio.

## Stack

- **Node.js 22** — ESModules (`"type": "module"`)
- **Baileys 7.0.0-rc13** — cliente WhatsApp multi-dispositivo
- **Claude claude-sonnet-4-6** — arquitectura tool_use + prompt caching + múltiples tools por mensaje
- **OpenAI Whisper** — transcripción de audios (modelo `whisper-1`, idioma `es`)
- **Google Sheets** — base de datos (hojas: Gastos, Ayuda, Deudas, Suscripciones, Eventos, Recordatorios, Cumpleanos)
- **Docker** — imagen `expense-tracker-app:3.0`, volumen persistente `app_data`

## Versión actual: 3.1.1

**Fixes incluidos en 3.1.1:**
- Avisos previos de eventos y suscripciones (3 días y 1 día antes) ahora salen a partir de las 21:00 AR (`HORA_AVISO_PREVIO`) — antes no tenían restricción horaria y salían en el primer chequeo después de medianoche (~00:xx), cuando el usuario ya no los ve hasta el día siguiente
- Aviso del mismo día de suscripciones ahora sale a partir de las 8:00 AR (antes también salía a la madrugada). El de eventos ya respetaba `avisoHora` (default 8:00)

**Nuevo en 3.1.0:**
- Módulo de Cumpleaños: registro con recurrencia anual (no hace falta volver a cargarlo cada año), año de nacimiento opcional (se pregunta/agrega de forma conversacional, nunca de entrada), 3 avisos automáticos por cumpleaños (1 mes antes, 1 semana antes con fecha relativa tipo "el lunes que viene", y el mismo día a las 00:01). Ver sección [Cumpleaños](#cumpleaños).

**Fixes incluidos en 3.0.3:**
- `startWhatsAppClient` ahora usa `fetchLatestWaWebVersion()` en vez de `fetchLatestBaileysVersion()` — esta scrapea `web.whatsapp.com/sw.js` para obtener la version real que WhatsApp esta sirviendo, en vez de leer el repo de Baileys en GitHub (que puede estar atrasado y además falla en silencio si no hay red, sin arreglar el loop de `statusCode 405`)

**Fixes incluidos en 3.0.2:**
- `startWhatsAppClient` ahora llama a `fetchLatestBaileysVersion()` y pasa `version` a `makeWASocket` — evita que la conexión quede en loop con `statusCode 405` cuando WhatsApp actualiza el protocolo web y el paquete de Baileys pinneado queda desactualizado

**Fixes incluidos en 3.0.1:**
- `ensureRecordatoriosHeaders` ahora verifica y sobreescribe headers incorrectos al arrancar (antes ignoraba cualquier header existente)
- `getRecordatoriosPendientes` filtra por `estado !== 'hecho'` en vez de `=== 'pendiente'` — más resiliente a datos desalineados
- `fechaHoyAR()` incluye la hora actual (HH:MM) en el contexto de Claude — necesario para calcular correctamente "recordame en X horas"

## Estructura

```
src/
  index.js                  — entry point
  ai/claude.js              — tools + system prompt + llamada a Claude API
  whatsapp/
    client.js               — conexión Baileys + handlers de todas las tools
    transcribe.js           — transcripción de audios con Whisper API
  sheets/client.js          — CRUD Google Sheets
  scheduler/
    weekly.js               — resumen semanal (domingo 23:00)
    monthly.js              — reporte mensual (día 1, 9:00)
    subscriptions.js        — recordatorios suscripciones (cada hora)
    events.js               — recordatorios eventos (cada hora)
    reminders.js            — recordatorios libres (cada 15 min, soporta snooze)
    birthdays.js            — recordatorios de cumpleaños (cada 15 min, recurrencia anual)
  state/conversation.js     — historial, pending actions, stack interactuadas
  config/index.js           — variables de entorno
  utils/logger.js           — pino logger
```

## Variables de entorno (.env)

```
ANTHROPIC_API_KEY=
OPENAI_API_KEY=                    # para transcripción de audios (Whisper)
GOOGLE_SHEET_ID=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_SERVICE_ACCOUNT_KEY=
WHATSAPP_SUMMARY_JID=              # formato: 549XXXXXXXXXX@s.whatsapp.net
WHATSAPP_AUTH_METHOD=qr
TZ=America/Argentina/Buenos_Aires
```

## Tools disponibles (35)

| Módulo | Tools |
|--------|-------|
| Gastos | registrar_gasto_ingreso, editar_gasto, eliminar_gasto, ver_resumen |
| Ayuda | registrar_ayuda, ver_resumen_ayuda |
| Deudas | registrar_deuda, sumar_deuda, pagar_deuda, ver_resumen_deudas, borrar_deudas_saldadas, borrar_todas_deudas |
| Suscripciones | registrar_suscripcion, cancelar_suscripcion, editar_suscripcion, eliminar_suscripcion, ver_suscripciones, snooze_suscripcion |
| Eventos | registrar_evento, ver_eventos, editar_evento, eliminar_evento |
| Recordatorios | registrar_recordatorio, ver_recordatorios, snooze_recordatorio, eliminar_recordatorio |
| Cumpleaños | registrar_cumpleanos, ver_cumpleanos, editar_cumpleanos, eliminar_cumpleanos |
| Reportes | ver_reporte_mensual |
| Sistema | confirmar_accion, rechazar_accion |

## Pipeline de audio

1. Baileys detecta `audioMessage`
2. Descarga el buffer
3. POST a Whisper API → texto transcripto
4. Claude procesa con system prompt especial de audio (lenguaje hablado, múltiples órdenes)
5. Se ejecutan **todas** las tools devueltas en secuencia (sin confirmación para edits)
6. Se responde con un resumen de cada operación

**Patrones que entiende el audio:**
- `"doscientos en nafta"` → gasto $200 transporte (sin verbo explícito)
- `"y quinientos en el super"` → segundo gasto encadenado
- `"la coca-cola es de social"` → editar categoría sin confirmación
- `"acordame el jueves hacer el informe"` → registrar_recordatorio
- `"borrá lo de la nafta"` → eliminar por búsqueda semántica

## Tipos de eventos

`turno` · `examen` · `reunion` · `social` · `pago` · `recordatorio` · `evento` · `otro`

`ver_eventos` agrupa por tipo con encabezados.

## Recordatorios

- Avisan el día configurado a la hora especificada (default 8:00)
- Eventos/suscripciones: aviso 3 días y 1 día antes a las 21:00, y el mismo día a las 8:00 (eventos: hora de `avisoHora`)
- Snooze libre: "recordamelo en X horas"
- Se auto-completan al avisar (desaparecen de la lista)
- Estado persistente: `/app/data/recordatorios_notif_state.json`

## Cumpleaños

- Recurrencia anual: se registra una sola vez (día + mes), no hay que volver a cargarlo cada año
- El año de nacimiento es opcional. Si no se sabe al registrar, no se pregunta — se agrega después de forma conversacional (ej. "Fede nació en el 98" → `editar_cumpleanos`) y a partir de ahí el bot calcula y avisa la edad
- 3 avisos automáticos por cumpleaños: 1 mes antes, 1 semana antes (con la fecha relativa, ej. "el lunes que viene") y el mismo día a las 00:01
- 29 de febrero: en años no bisiestos el aviso se corre al 1 de marzo
- Eliminar/editar requieren confirmación (igual que Suscripciones/Eventos); registrar es directo
- Estado persistente: `/app/data/cumpleanos_notif_state.json`

## Categorías de gastos

| Categoría | Qué incluye |
|-----------|-------------|
| comida | supermercado, verdulería, delivery |
| social | salidas con otras personas, cumples, meriendas con alguien |
| recreacion | gustos personales y solo (helado, cine, etc.) |
| transporte | nafta, SUBE, Uber, remis |
| tecnologia | dispositivos, cursos, software |
| suscripciones | servicios recurrentes (Netflix, Spotify, etc.) |
| salud | médico, farmacia, obra social |
| hogar | wifi, ropa, cosas de casa, gastos fijos |
| otros | catch-all |

**Regla social vs recreacion:** si hay otra persona involucrada → social. Si es solo → recreacion. Si no queda claro, el bot pregunta antes de registrar.

## Deploy

```bash
# Primera vez o rebuild completo
cd /opt/expense-tracker
tar -xzf whatsapp-expense-tracker-v3.1.1.tar.gz
docker-compose build --no-cache
docker-compose up -d
docker logs expense-tracker-app -f   # escanear QR si es primera vez
```

```bash
# Actualización de código (sin cambiar dependencias)
docker-compose build
docker-compose up -d
```

## Sesión WhatsApp

La sesión se guarda en el volumen Docker `expense-tracker_app_data` bajo `/app/data/wa-session/`. **No borrar este volumen** salvo que se quiera re-vincular el dispositivo.

Si aparece el error "esperando este mensaje" en WhatsApp: es una sesión Signal corrupta. Solución: borrar `/app/data/wa-session/*`, reiniciar y re-escanear QR.

## Estado persistente

- `/app/data/notif_state.json` — suscripciones ya notificadas
- `/app/data/eventos_notif_state.json` — eventos ya notificados
- `/app/data/recordatorios_notif_state.json` — recordatorios ya notificados
- `/app/data/cumpleanos_notif_state.json` — avisos de cumpleaños ya notificados
