/**
 * One entry point for every model call: tiers, timeouts, streaming, limits and usage logging, over either an
 * OpenAI-style endpoint (NVIDIA Nemotron) or Anthropic's API. Callers get text plus usage, or an AiError with
 * a stable code, and never need to know which provider answered.
 */
const Anthropic = require('@anthropic-ai/sdk');
const {
  tiers, estimateCostUsd, providerKind, openaiEndpoint, jsonModeEnabled,
} = require('./config');
const openai = require('./providers/openaiCompat');
const { AiError, CODES } = require('./errors');
const { checkRate, checkBudget, recordTokens } = require('./limits');
const { logUsage } = require('./telemetry');
const logger = require('../utils/logger');

let client = null;
function getClient() {
  // Resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the environment.
  if (!client) client = new Anthropic({ maxRetries: 2 });
  return client;
}

/**
 * Server-side refusal fallback for the models that support it (Claude API only): a policy decline is
 * re-run on Anthropic's recommended model instead of coming back as a refusal. Off with AI_FALLBACKS=false.
 */
const FALLBACK_MODELS = /^claude-(sonnet-5-5|opus-5)/;

function openStream(model, params, options) {
  const api = getClient();
  if (process.env.AI_FALLBACKS !== 'false' && FALLBACK_MODELS.test(model) && api.beta?.messages?.stream) {
    return api.beta.messages.stream(
      { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
      options
    );
  }
  return api.messages.stream(params, options);
}

function mapError(err, { timedOut, aborted }) {
  if (err instanceof AiError) return err;
  if (timedOut) return new AiError(CODES.TIMEOUT, 'The AI took too long to answer.', { status: 504, cause: err });
  if (aborted) return new AiError(CODES.UPSTREAM, 'Request cancelled.', { status: 499, cause: err });
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    logger.error(`ai: Anthropic rejected our credentials (${err.status})`);
    return new AiError(CODES.UPSTREAM, 'AI is not configured correctly.', { status: 503, cause: err });
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
    logger.error(`ai: Anthropic rejected the request (${err.status}): ${err.message}`);
    return new AiError(CODES.UPSTREAM, 'AI request was rejected.', { status: 502, cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AiError(CODES.UPSTREAM, 'AI is busy. Try again shortly.', { status: 503, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AiError(CODES.UPSTREAM, 'Could not reach the AI service.', { status: 503, cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new AiError(CODES.UPSTREAM, 'The AI service had a problem.', { status: 502, cause: err });
  }
  return new AiError(CODES.UPSTREAM, 'AI request failed.', { status: 500, cause: err });
}

// Models that rejected a JSON schema once; we then ask for JSON in the prompt instead.
const noStructuredOutput = new Set();

const looksLikeSchemaRejection = (err) => err instanceof Anthropic.BadRequestError
  && /output_config|output_format|json_schema|structured|format/i.test(String(err.message));

/** The first complete JSON object in free text (used when no schema could be enforced). */
function parseJsonLoose(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

function buildParams(tierCfg, { system, messages, maxTokens, outputSchema, schemaInPrompt }) {
  const systemText = schemaInPrompt && outputSchema
    ? `${system}

Reply with only a JSON object that matches this JSON Schema:
${JSON.stringify(outputSchema)}`
    : system;
  const params = {
    model: tierCfg.model,
    max_tokens: maxTokens || tierCfg.maxTokens,
    // The system prompt and schema are identical across calls, so cache them.
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    messages,
  };
  const outputConfig = {};
  if (tierCfg.effort) outputConfig.effort = tierCfg.effort;
  if (outputSchema && !schemaInPrompt) outputConfig.format = { type: 'json_schema', schema: outputSchema };
  if (Object.keys(outputConfig).length) params.output_config = outputConfig;
  return params;
}

/** System prompt with the output schema appended (used when the endpoint cannot enforce a schema itself). */
function schemaPrompt(system, outputSchema) {
  return `${system}

Reply with only a JSON object that matches this JSON Schema, with no text before or after it:
${JSON.stringify(outputSchema)}`;
}

/**
 * One streamed model turn on the configured provider.
 * @returns {Promise<object>} the reply as content blocks plus stop_reason and usage
 */
async function callModel(tierCfg, {
  system, messages, tools, maxTokens, outputSchema, schemaInPrompt, signal, onText,
}) {
  if (providerKind() === 'openai') {
    const { message } = await openai.complete(openaiEndpoint(), {
      model: tierCfg.model,
      system: outputSchema ? schemaPrompt(system, outputSchema) : system,
      messages,
      tools,
      maxTokens: maxTokens || tierCfg.maxTokens,
      temperature: tierCfg.temperature,
      thinking: tierCfg.thinking,
      jsonMode: Boolean(outputSchema) && jsonModeEnabled(),
      signal,
      onText,
    });
    return message;
  }
  const params = buildParams(tierCfg, { system, messages, maxTokens, outputSchema, schemaInPrompt });
  if (tools?.length) params.tools = tools;
  const stream = openStream(tierCfg.model, params, { signal });
  if (onText) stream.on('text', onText);
  try {
    return await stream.finalMessage();
  } catch (err) {
    // With streamed tool input, unparseable JSON surfaces as a plain error (not an API error).
    if (!(err instanceof Anthropic.APIError) && !signal?.aborted && !(err instanceof AiError)) {
      throw new AiError(CODES.BAD_OUTPUT, 'The AI produced an unreadable tool call.', { status: 502, cause: err });
    }
    throw err;
  }
}

/**
 * Run one model call.
 *
 * @param {object} opts
 * @param {string} opts.feature        Name used in logs and usage rows, e.g. "preset-analysis".
 * @param {'fast'|'deep'} [opts.tier]
 * @param {string} opts.system         Stable instructions (cached across calls).
 * @param {string|object[]} opts.user  User text, or a full messages array.
 * @param {object} [opts.outputSchema] JSON Schema; the reply is then parsed into `json`.
 * @param {(text: string) => void} [opts.onText] Called with each streamed text chunk.
 * @param {{userId?: string, clientId?: string}} [opts.ctx]
 * @param {AbortSignal} [opts.signal]  Abort when the HTTP client disconnects.
 */
async function run(opts) {
  const {
    feature, tier = 'fast', system, user, outputSchema, onText, ctx = {}, signal, maxTokens,
  } = opts;
  const tierCfg = tiers()[tier];
  if (!tierCfg) throw new Error(`Unknown AI tier: ${tier}`);
  const base = { userId: ctx.userId, clientId: ctx.clientId, feature, tier, model: tierCfg.model };

  try {
    if (ctx.userId) {
      await checkRate(ctx.userId);
      await checkBudget(ctx.userId, ctx.clientId);
    }
  } catch (err) {
    logUsage({ ...base, status: err.code === CODES.BUDGET ? 'budget' : 'rate_limited', errorCode: err.code });
    throw err;
  }

  const messages = Array.isArray(user) ? user : [{ role: 'user', content: String(user) }];
  // OpenAI-style endpoints always get the schema in the prompt; Anthropic enforces it unless it once refused.
  const schemaInPrompt = Boolean(outputSchema)
    && (providerKind() === 'openai' || noStructuredOutput.has(tierCfg.model));

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, tierCfg.timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const started = Date.now();
  let firstTokenMs = null;
  try {
    const message = await callModel(tierCfg, {
      system,
      messages,
      maxTokens,
      outputSchema,
      schemaInPrompt,
      signal: controller.signal,
      onText: (chunk) => {
        if (firstTokenMs == null) firstTokenMs = Date.now() - started;
        if (onText) onText(chunk);
      },
    });
    const latencyMs = Date.now() - started;

    if (message.stop_reason === 'refusal') {
      throw new AiError(CODES.REFUSAL, 'The AI declined to answer this request.', { status: 422 });
    }
    const text = (message.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let json;
    if (outputSchema) {
      try {
        json = schemaInPrompt ? parseJsonLoose(text) : JSON.parse(text);
      } catch (parseErr) {
        throw new AiError(CODES.BAD_OUTPUT, 'The AI reply was not valid JSON.', { status: 502, cause: parseErr });
      }
    }

    const u = message.usage || {};
    logUsage({
      ...base,
      status: 'ok',
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens,
      cacheWriteTokens: u.cache_creation_input_tokens,
      latencyMs,
      firstTokenMs,
      estCostUsd: estimateCostUsd(tierCfg.model, u),
    });
    recordTokens(ctx.userId, ctx.clientId, (u.input_tokens || 0) + (u.output_tokens || 0)).catch(() => {});

    return {
      text,
      json,
      truncated: message.stop_reason === 'max_tokens',
      model: tierCfg.model,
      tier,
      usage: u,
      latencyMs,
      firstTokenMs,
    };
  } catch (err) {
    if (outputSchema && !schemaInPrompt && looksLikeSchemaRejection(err)) {
      // This model does not take a JSON schema: remember that and retry once with the schema in the prompt.
      noStructuredOutput.add(tierCfg.model);
      logger.warn(`ai: ${tierCfg.model} rejected the JSON schema; retrying with the schema in the prompt`);
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      return run(opts);
    }
    const mapped = mapError(err, { timedOut, aborted: controller.signal.aborted && !timedOut });
    logUsage({
      ...base,
      status: 'error',
      latencyMs: Date.now() - started,
      firstTokenMs,
      errorCode: mapped.code,
    });
    throw mapped;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * One model turn that may call tools. The caller runs the tools and loops; this handles limits,
 * timeouts, streaming text and usage logging for the turn.
 *
 * @param {object} opts
 * @param {string} opts.feature
 * @param {'fast'|'deep'|'chat'} [opts.tier]
 * @param {string} opts.system
 * @param {object[]} opts.messages
 * @param {object[]} [opts.tools]
 * @param {(text: string) => void} [opts.onText]
 * @param {boolean} [opts.skipRate]   later turns of one question count once against the per-minute rate
 * @returns {Promise<{message: object, latencyMs: number}>}
 */
async function runTurn(opts) {
  const {
    feature, tier = 'chat', system, messages, tools, maxTokens, ctx = {}, signal, onText, skipRate = false,
  } = opts;
  const tierCfg = tiers()[tier];
  if (!tierCfg) throw new Error(`Unknown AI tier: ${tier}`);
  const base = { userId: ctx.userId, clientId: ctx.clientId, feature, tier, model: tierCfg.model };

  try {
    if (ctx.userId) {
      if (!skipRate) await checkRate(ctx.userId);
      await checkBudget(ctx.userId, ctx.clientId);
    }
  } catch (err) {
    logUsage({ ...base, status: err.code === CODES.BUDGET ? 'budget' : 'rate_limited', errorCode: err.code });
    throw err;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, tierCfg.timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const started = Date.now();
  let firstTokenMs = null;
  try {
    const message = await callModel(tierCfg, {
      system,
      messages,
      tools,
      maxTokens,
      signal: controller.signal,
      onText: (chunk) => {
        if (firstTokenMs == null) firstTokenMs = Date.now() - started;
        if (onText) onText(chunk);
      },
    });
    const latencyMs = Date.now() - started;
    const u = message.usage || {};
    logUsage({
      ...base,
      status: 'ok',
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens,
      cacheWriteTokens: u.cache_creation_input_tokens,
      latencyMs,
      firstTokenMs,
      estCostUsd: estimateCostUsd(tierCfg.model, u),
    });
    recordTokens(ctx.userId, ctx.clientId, (u.input_tokens || 0) + (u.output_tokens || 0)).catch(() => {});
    return { message, latencyMs, model: tierCfg.model };
  } catch (err) {
    const mapped = mapError(err, { timedOut, aborted: controller.signal.aborted && !timedOut });
    logUsage({ ...base, status: 'error', latencyMs: Date.now() - started, firstTokenMs, errorCode: mapped.code });
    throw mapped;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

/** Test seam: swap in a fake client so tests never call the network. */
function setClientForTests(fake) {
  client = fake;
}

/** Test seam for the OpenAI-style provider: replace the network call. */
const setFetchForTests = openai.setFetchForTests;

module.exports = { run, runTurn, setClientForTests, setFetchForTests };
