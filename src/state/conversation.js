// Manejo de estado en memoria por usuario (jid)
// Cuatro estructuras independientes:
//   1. pendingActions   → accion esperando confirmacion (expira en 1 min)
//   2. messageHistory   → ultimos 5 mensajes de la conversacion
//   3. interactedStack  → stack de ultimas 5 filas interactuadas (para "el anterior", "ese no el otro")
//   4. pendingMedia     → imagen/PDF recien enviado, esperando que se resuelva como evento o archivo (expira en 3 min)

const STATE_TTL_MS  = 60 * 1000;
const MEDIA_TTL_MS  = 3 * 60 * 1000;
const MAX_HISTORY   = 5;
const MAX_STACK     = 5;

const pendingActions  = new Map();
const messageHistory  = new Map();
const interactedStack = new Map();
const pendingMedia    = new Map();

// ── Pending actions ──────────────────────────────────────────────────────────

export function setPendingAction(jid, action) {
  const existing = pendingActions.get(jid);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => pendingActions.delete(jid), STATE_TTL_MS);
  pendingActions.set(jid, { ...action, timer, createdAt: Date.now() });
}

export function getPendingAction(jid) {
  return pendingActions.get(jid) ?? null;
}

export function clearPendingAction(jid) {
  const existing = pendingActions.get(jid);
  if (existing?.timer) clearTimeout(existing.timer);
  pendingActions.delete(jid);
}

export function hasPendingAction(jid) {
  return pendingActions.has(jid);
}

// ── Historial de mensajes ────────────────────────────────────────────────────

export function pushHistory(jid, role, text) {
  if (!messageHistory.has(jid)) messageHistory.set(jid, []);
  const history = messageHistory.get(jid);
  history.push({ role, text, ts: Date.now() });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

export function getHistory(jid) {
  return messageHistory.get(jid) ?? [];
}

// ── Stack de filas interactuadas ─────────────────────────────────────────────
// Cada entrada: { rowObject, rowIndex }
// El mas reciente esta al final del array (index -1)

export function pushInteracted(jid, rowObject, rowIndex) {
  if (!interactedStack.has(jid)) interactedStack.set(jid, []);
  const stack = interactedStack.get(jid);

  // Evitar duplicados consecutivos del mismo ID
  if (stack.length > 0 && stack[stack.length - 1].rowObject?.id === rowObject?.id) return;

  stack.push({ rowObject, rowIndex });
  if (stack.length > MAX_STACK) stack.splice(0, stack.length - MAX_STACK);
}

// Devuelve el stack completo (el mas reciente al final)
export function getInteractedStack(jid) {
  return interactedStack.get(jid) ?? [];
}

// Devuelve solo el ultimo interactuado (compatibilidad con logica existente)
export function getLastInteracted(jid) {
  const stack = interactedStack.get(jid);
  if (!stack || stack.length === 0) return null;
  return stack[stack.length - 1];
}

// Limpia el ultimo del stack (ej: despues de eliminar)
export function popInteracted(jid) {
  const stack = interactedStack.get(jid);
  if (stack && stack.length > 0) stack.pop();
}

// Alias para compatibilidad — setLastInteracted sigue funcionando
export function setLastInteracted(jid, rowObject, rowIndex) {
  if (!rowObject) return;
  pushInteracted(jid, rowObject, rowIndex);
}

// ── Media pendiente (imagen/PDF sin resolver aun) ────────────────────────────
// media: { buffer, mediaType, tipo: 'imagen'|'documento' }

export function setPendingMedia(jid, media) {
  const existing = pendingMedia.get(jid);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => pendingMedia.delete(jid), MEDIA_TTL_MS);
  pendingMedia.set(jid, { ...media, timer, createdAt: Date.now() });
}

export function getPendingMedia(jid) {
  return pendingMedia.get(jid) ?? null;
}

export function clearPendingMedia(jid) {
  const existing = pendingMedia.get(jid);
  if (existing?.timer) clearTimeout(existing.timer);
  pendingMedia.delete(jid);
}
