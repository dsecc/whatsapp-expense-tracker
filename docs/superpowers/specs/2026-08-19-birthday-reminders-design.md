# Módulo de Cumpleaños — Diseño

Fecha: 2026-08-19

## Objetivo

Agregar un módulo para registrar cumpleaños de personas y recibir avisos automáticos por WhatsApp, con recurrencia anual (a diferencia de Recordatorios/Eventos, que son de una sola vez).

## Decisión de arquitectura

Módulo propio (hoja + scheduler + tools), siguiendo el patrón de `Suscripciones` — es el único módulo existente que ya resuelve "recurrencia" (recalcula el próximo vencimiento sin volver a registrar nada). Un cumpleaños es la misma idea pero con recurrencia anual en vez de mensual.

Se descartó integrarlo en `Eventos` o `Recordatorios` porque ambos son de una sola ocurrencia (se marcan "hecho" y desaparecen); forzarles recurrencia anual + año opcional + 3 avisos distintos hubiera complicado esos módulos sin necesidad.

## Datos

Hoja nueva `Cumpleanos` (sin ñ/acentos, igual que el resto de las hojas):

| Columna | Campo | Notas |
|---|---|---|
| A | ID | autoincremental |
| B | Nombre | |
| C | Dia | 1-31 |
| D | Mes | 1-12 |
| E | Anio | opcional, vacío si no se sabe |
| F | Notas | opcional (ideas de regalo, etc.) |

Sin columna de "estado": un cumpleaños activo vive mientras exista la fila (eliminar = borrar fila, como Recordatorios/Eventos).

## Tools (Claude)

- `registrar_cumpleanos(nombre, dia, mes, anio?, notas?)` — Usar cuando el usuario diga "el cumpleaños de X es el...", "anotá que Fede cumple años el...". Si no menciona el año, se guarda sin año — **no preguntar por el año**, es opcional y natural que no lo tenga a mano.
- `editar_cumpleanos(nombre_busqueda, nuevo_nombre?, nuevo_dia?, nuevo_mes?, nuevo_anio?, nuevas_notas?)` — Cubre el caso central pedido por el usuario: "che, Fede nació en el 98" en cualquier momento posterior debe poder actualizar solo el año de un cumpleaños ya cargado, de forma conversacional.
- `eliminar_cumpleanos(nombre_busqueda)`
- `ver_cumpleanos()` — Lista ordenada por próxima ocurrencia (el más próximo primero), muestra edad que cumple si hay año.

No lleva `snooze`: a diferencia de una suscripción (posponer un pago) no tiene sentido posponer el cumpleaños de alguien.

## Cálculo de "próxima ocurrencia"

Igual a `proximoVencimientoPaga` de `subscriptions.js` pero anual: si hoy (AR) es `<=` dia/mes de este año → ocurre este año; si no → año que viene. 29 de febrero: si el año actual no es bisiesto, la ocurrencia se corre al 1 de marzo (evita que el scheduler nunca dispare en años no bisiestos).

## Avisos

Tres avisos por ocurrencia, calculados en días restantes hasta la próxima ocurrencia:

- **30 días antes** — pie para organizar/comprar algo.
- **7 días antes** — mensaje con la fecha relativa al estilo que ya usa el sistema ("el lunes que viene", etc. — mismo criterio conversacional de fechas relativas usado en el resto del bot).
- **El mismo día, a las 00:01** — mensaje principal ("Hoy es el cumpleaños de X" + edad si hay año).

Estado de notificación persistente en `/app/data/cumpleanos_notif_state.json`, mismo patrón que `notif_state.json` / `recordatorios_notif_state.json`: clave `id-tramo-año` (tramo = 30/7/0) para no repetir el aviso, se limpia a los 14 días.

El scheduler corre cada 15 minutos (igual que `reminders.js`) en vez de cada hora (como `subscriptions.js`), porque el aviso del día-mismo debe dispararse cerca de las 00:01 y no quedar pendiente hasta la próxima corrida horaria.

## Mensajes (ejemplos)

- 30 días: `En un mes es el cumpleaños de *Fede* (15/9). Tiempo de ir pensando un regalo.`
- 7 días: `El lunes que viene es el cumpleaños de *Fede* (15/9).`
- Día mismo: `Hoy cumple años *Fede*` + (si hay año) ` — cumple *28*.`

## Integración

- `sheets/client.js`: `ensureCumpleanosHeaders`, `appendCumpleanos`, `getAllCumpleanos`, `findCumpleanos`, `editarCumpleanos`, `eliminarCumpleanos`.
- `scheduler/birthdays.js`: nuevo, calcado de `reminders.js`/`subscriptions.js`.
- `ai/claude.js`: 4 tools nuevas (arriba).
- `whatsapp/client.js`: handlers de las 4 tools + wiring de `ensureCumpleanosHeaders()` y `startBirthdaysScheduler()` en el arranque.
- `CLAUDE.md`: documentar el módulo nuevo y bump de versión.

## Edge cases

- Sin año → nunca calcular/mostrar edad, sin preguntar proactivamente por él.
- Búsqueda de nombre case-insensitive + substring, igual que `editarSuscripcion`/`eliminarSuscripcion`.
- Dos personas con mismo nombre parcial: mismo comportamiento actual del sistema (toma la primera coincidencia) — no es un caso nuevo a resolver acá.

## Testing

No hay suite de tests en el proyecto (verificado: no hay `test` script real, solo `start`/`dev`). Verificación: `node --check` sobre los archivos modificados/nuevos, y revisión manual del flujo de cálculo de fechas (próxima ocurrencia, 29/feb, tramos de aviso).
