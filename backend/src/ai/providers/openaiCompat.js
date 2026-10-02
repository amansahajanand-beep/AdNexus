/**
 * Adapter for OpenAI-style chat-completions endpoints (NVIDIA-hosted Nemotron and similar).
 *
 * The rest of the AI layer speaks one message shape: content blocks (text, tool_use, tool_result) and a
 * stop_reason. This file translates that to chat-completions requests and back, so the analysis, the chat
 * loop and the report need no knowledge of which provider answers.
 */
const { AiError, CODES } = require('../errors');
const logger = require('../../utils/logger');

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 700;

let fetchImpl = (...args) => fetch(...args);
/** Test seam: replace the network call. */
function setFetchForTests(fn) {
  fetchImpl = fn || ((...args) => fetch(...args));
}

// Server options this endpoint rejected once; they are left out from then on.
const unsupported = { jsonMode: false, thinkingSwitch: false };

class Transient extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

// ─── message translation ──────────────────────────────────────────────────────

const blockText = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');

function toToolContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('');
  return JSON.stringify(content ?? '');
}

/** Anthropic-shaped messages (+ system text) -> chat-completions messages. */
function toOpenAiMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const msg = { role: 'assistant', content: blockText(blocks) || (toolCalls.length ? null : '') };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }
    // User turn: tool results become their own "tool" messages, any text follows as a user message.
    for (const b of blocks.filter((x) => x.type === 'tool_result')) {
      const text = toToolContent(b.content);
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${text}` : text });
    }
    const text = blockText(blocks);
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

function toOpenAiTools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** Drops <think>…</think> that some deployments put inline instead of in reasoning_content. */
class ThinkFilter {
  constructor() { this.buffer = ''; this.inThink = false; this.decided = false; }

  push(chunk) {
    let text = this.buffer + chunk;
    this.buffer = '';
    let visible = '';
    while (text) {
      if (this.inThink) {
        const end = text.indexOf('</think>');
        if (end < 0) {
          // Keep the tail: the closing tag may arrive split across chunks.
          this.buffer = text.slice(-7);
          return visible;
        }
        text = text.slice(end + 8).replace(/^\s+/, '');
        this.inThink = false;
        continue;
      }
      const start = text.indexOf('<think>');
      if (start >= 0) {
        visible += text.slice(0, start);
        text = text.slice(start + 7);
        this.inThink = true;
        continue;
      }
      // Hold back a possible partial opening tag at the very end.
      const keep = ['<think', '<thin', '<thi', '<th', '<t', '<'].find((p) => text.endsWith(p));
      if (keep) { this.buffer = keep; text = text.slice(0, -keep.length); }
      visible += text;
      text = '';
    }
    return visible;
  }

  flush() {
    const rest = this.inThink ? '' : this.buffer;
    this.buffer = '';
    return rest;
  }
}

// ─── one request ──────────────────────────────────────────────────────────────

function isRetryableStreamError(err) {
  const code = Number(err?.code);
  return RETRYABLE_STATUS.has(code) || /overload|unavailable|rate|timeout|busy/i.test(`${err?.type || ''} ${err?.message || ''}`);
}

async function attempt(cfg, body, { signal, onText, markEmitted }) {
  let res;
  try {
    res = await fetchImpl(cfg.url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (signal?.aborted || err.name === 'AbortError') throw err;
    throw new Transient(`network error: ${err.message}`, 0);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 400);
    if (RETRYABLE_STATUS.has(res.status)) throw new Transient(`HTTP ${res.status}`, res.status);
    throw new HttpError(res.status, text);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const filter = new ThinkFilter();
  const calls = new Map();
  let buffer = '';
  let text = '';
  let finish = null;
  let usage = null;
  let sawChunk = false;

  const handle = (data) => {
    if (data === '[DONE]') return;
    let json;
    try { json = JSON.parse(data); } catch { return; }
    if (json.error) {
      if (isRetryableStreamError(json.error) && !text && !calls.size) throw new Transient(json.error.message || 'overloaded', Number(json.error.code) || 503);
      throw new AiError(CODES.UPSTREAM, 'The AI service reported an error.', { status: 502, cause: new Error(JSON.stringify(json.error).slice(0, 300)) });
    }
    if (json.usage) usage = json.usage;
    const choice = json.choices?.[0];
    if (!choice) return;
    sawChunk = true;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta || {};
    // delta.reasoning_content / delta.reasoning is the model's private thinking: never shown or stored.
    if (delta.content) {
      const visible = filter.push(delta.content);
      if (visible) {
        text += visible;
        markEmitted();
        onText?.(visible);
      }
    }
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      const cur = calls.get(idx) || { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(idx, cur);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
    let i = buffer.indexOf('\n\n');
    while (i >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      for (const line of block.split('\n')) if (line.startsWith('data:')) handle(line.slice(5).trim());
      i = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim());
  text += filter.flush();

  if (!sawChunk && !text && !calls.size) throw new Transient('empty response', 0);
  return { text, calls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c), finish, usage };
}

/**
 * One model turn.
 * @param {{url: string, key: string}} cfg
 * @param {object} opts  { model, system, messages, tools, maxTokens, temperature, thinking, jsonMode, signal, onText }
 * @returns {Promise<{message: object}>}  message in the shared shape (content blocks, stop_reason, usage)
 */
async function complete(cfg, opts) {
  const {
    model, system, messages, tools, maxTokens, temperature = 0.2, thinking = false, jsonMode = false, signal, onText,
  } = opts;

  const build = () => {
    const body = {
      model,
      messages: toOpenAiMessages(system, messages),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
      temperature,
    };
    if (!unsupported.thinkingSwitch) body.chat_template_kwargs = { enable_thinking: Boolean(thinking) };
    if (tools?.length) { body.tools = toOpenAiTools(tools); body.tool_choice = 'auto'; }
    if (jsonMode && !unsupported.jsonMode) body.response_format = { type: 'json_object' };
    return body;
  };

  let emitted = false;
  let lastError;
  for (let n = 0; n < MAX_ATTEMPTS; n += 1) {
    try {
      const r = await attempt(cfg, build(), { signal, onText, markEmitted: () => { emitted = true; } });
      const content = [];
      if (r.text) content.push({ type: 'text', text: r.text });
      for (const c of r.calls) {
        let input;
        try {
          input = c.args.trim() ? JSON.parse(c.args) : {};
        } catch (err) {
          throw new AiError(CODES.BAD_OUTPUT, 'The AI produced an unreadable tool call.', { status: 502, cause: err });
        }
        content.push({ type: 'tool_use', id: c.id || `call_${n}_${content.length}`, name: c.name, input });
      }
      const stopReason = r.calls.length ? 'tool_use'
        : r.finish === 'length' ? 'max_tokens'
          : r.finish === 'content_filter' ? 'refusal' : 'end_turn';
      const inTok = r.usage?.prompt_tokens;
      const outTok = r.usage?.completion_tokens;
      return {
        message: {
          role: 'assistant',
          content,
          stop_reason: stopReason,
          usage: {
            input_tokens: inTok ?? Math.ceil(JSON.stringify(messages).length / 4),
            output_tokens: outTok ?? Math.ceil((r.text.length + r.calls.reduce((a, c) => a + c.args.length, 0)) / 4),
          },
        },
      };
    } catch (err) {
      if (err instanceof HttpError) {
        // An option this deployment does not understand: remember, drop it, and try once more straight away.
        if (err.status === 400 || err.status === 422) {
          if (/response_format|json_object/i.test(err.body) && !unsupported.jsonMode) {
            unsupported.jsonMode = true;
            logger.warn('ai: endpoint rejected response_format; JSON is requested in the prompt only');
            n -= 1;
            continue;
          }
          if (/chat_template_kwargs|enable_thinking/i.test(err.body) && !unsupported.thinkingSwitch) {
            unsupported.thinkingSwitch = true;
            logger.warn('ai: endpoint rejected chat_template_kwargs; thinking cannot be switched off');
            n -= 1;
            continue;
          }
        }
        if (err.status === 401 || err.status === 403) {
          logger.error(`ai: the AI endpoint rejected our credentials (${err.status})`);
          throw new AiError(CODES.UPSTREAM, 'AI is not configured correctly.', { status: 503, cause: err });
        }
        logger.error(`ai: the AI endpoint rejected the request (${err.status}): ${err.body}`);
        throw new AiError(CODES.UPSTREAM, 'AI request was rejected.', { status: 502, cause: err });
      }
      if (!(err instanceof Transient)) throw err;
      lastError = err;
      // A retry after text was already shown would repeat it.
      if (emitted || n === MAX_ATTEMPTS - 1) break;
      logger.info(`ai: ${err.message}; retrying (${n + 1}/${MAX_ATTEMPTS - 1})`);
      await sleep(BACKOFF_MS * (2 ** n) + Math.floor(Math.random() * 250), signal);
    }
  }
  throw new AiError(CODES.UPSTREAM, 'AI is busy. Try again shortly.', { status: 503, cause: lastError });
}

/** Forget remembered server quirks (tests). */
function resetQuirks() {
  unsupported.jsonMode = false;
  unsupported.thinkingSwitch = false;
}

module.exports = {
  complete, setFetchForTests, resetQuirks, toOpenAiMessages, toOpenAiTools, ThinkFilter,
};
