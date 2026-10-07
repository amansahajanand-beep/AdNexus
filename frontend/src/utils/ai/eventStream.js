import { getToken } from '../api';
import { reportTzHeaders } from '../reportTimezone';

const API_BASE = process.env.REACT_APP_API_URL || '/api';

function parseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}

export function toError(message, status, code) {
  const err = new Error(message || 'Something went wrong.');
  err.status = status;
  err.code = code || null;
  return err;
}

/**
 * POST to an AI endpoint that answers with server-sent events and hand each event to onEvent.
 * Resolves when the stream ends; rejects on an HTTP error or an `error` event (Error has status and code).
 */
export async function postEventStream(path, body, { signal, onEvent } = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      // The AI reads the same days the pages show.
      ...reportTzHeaders(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let payload = {};
    try { payload = await res.json(); } catch { /* not JSON */ }
    throw toError(payload.error, res.status, payload.code);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const parsed = parseBlock(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      if (parsed) {
        if (parsed.event === 'error') throw toError(parsed.data.error, 500, parsed.data.code);
        onEvent?.(parsed.event, parsed.data);
      }
      idx = buffer.indexOf('\n\n');
    }
  }
}
