import { ApiError, bad, conflict } from './errors.js';

const MAX_MESSAGES = 100;
const MAX_MESSAGE_LENGTH = 500;
const SEND_COOLDOWN_MS = 1000;

let enabled = false;
let revision = 0;
let nextId = 1;
const messages = [];
const lastSentAt = new Map();

export function resetLiveChat(open) {
  enabled = Boolean(open);
  revision += 1;
  nextId = 1;
  messages.length = 0;
  lastSentAt.clear();
}

export function setLiveChatEnabled(value) {
  if (typeof value !== 'boolean') {
    throw bad('Estado inválido para o chat.', 'invalid_chat_state');
  }
  enabled = value;
  return liveChatStatus();
}

export function clearLiveChat() {
  revision += 1;
  nextId = 1;
  messages.length = 0;
  lastSentAt.clear();
  return liveChatStatus();
}

export function liveChatStatus() {
  return { enabled, messageCount: messages.length };
}

export function readLiveChat(after = 0, clientRevision = null) {
  const cursor = after ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw bad('Cursor de mensagens inválido.', 'invalid_chat_cursor');
  }
  if (clientRevision !== null && clientRevision !== undefined
    && !Number.isSafeInteger(clientRevision)) {
    throw bad('Revisão de mensagens inválida.', 'invalid_chat_cursor');
  }
  const reset = clientRevision === null
    || clientRevision === undefined
    || clientRevision !== revision;
  return {
    revision,
    reset,
    messages: (reset ? messages : messages.filter((message) => message.id > cursor))
      .map((message) => ({ ...message })),
  };
}

export function sendLiveChatMessage(viewerId, nick, value) {
  if (!enabled) throw conflict('O chat foi pausado pelo host.', 'chat_disabled');
  if (typeof value !== 'string') {
    throw bad('A mensagem deve ser um texto.', 'invalid_chat_message');
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_MESSAGE_LENGTH) {
    throw bad(`A mensagem deve ter de 1 a ${MAX_MESSAGE_LENGTH} caracteres.`, 'invalid_chat_message');
  }

  const id = String(viewerId ?? '');
  const t = Date.now();
  const previous = lastSentAt.get(id);
  if (previous !== undefined && t - previous < SEND_COOLDOWN_MS) {
    throw new ApiError(429, 'rate_limited', 'Aguarde um instante antes de enviar outra mensagem.', {
      retryAfterSec: 1,
    });
  }
  lastSentAt.set(id, t);
  if (lastSentAt.size > 5000) {
    for (const [viewer, sentAt] of lastSentAt) {
      if (t - sentAt > 60_000) lastSentAt.delete(viewer);
    }
  }

  const message = { id: nextId++, nick, text, at: t };
  messages.push(message);
  if (messages.length > MAX_MESSAGES) messages.shift();
  return { ...message };
}
