/**
 * AI foundation settings. Everything is overridable by env so the provider, models, limits and the
 * on/off switch can change without a deploy.
 *
 * Providers:
 *  - "openai"    any OpenAI-style chat-completions endpoint (e.g. NVIDIA-hosted Nemotron).
 *                Needs AI_API_URL, AI_API_KEY and AI_MODEL.
 *  - "anthropic" Anthropic's API. Needs ANTHROPIC_API_KEY.
 * AI_PROVIDER picks one explicitly; otherwise "openai" is used when AI_API_URL and AI_API_KEY are set.
 */
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
/** JSON mode makes this kind of endpoint hold back the whole reply, which kills streaming. Off unless asked for. */
const jsonModeEnabled = () => String(process.env.AI_JSON_MODE || '').toLowerCase() === 'true';
const flag = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');

function providerKind() {
  const explicit = String(process.env.AI_PROVIDER || '').toLowerCase();
  if (explicit === 'openai' || explicit === 'anthropic') return explicit;
  return process.env.AI_API_URL && process.env.AI_API_KEY ? 'openai' : 'anthropic';
}

function openaiEndpoint() {
  return { url: process.env.AI_API_URL, key: process.env.AI_API_KEY };
}

/**
 * Model tiers. `fast` is the instant summary, `deep` the on-demand analysis, `chat` the ask-your-data loop.
 * On the OpenAI-style provider thinking is off unless asked for: with it on, this class of model writes
 * thousands of tokens of private reasoning first, which costs seconds and eats the output budget.
 */
function tiers() {
  if (providerKind() === 'openai') {
    const model = process.env.AI_MODEL;
    const overall = int(process.env.AI_TIMEOUT_MS, 120_000);
    return {
      fast: {
        model,
        maxTokens: int(process.env.AI_MAX_TOKENS_FAST, 1500),
        timeoutMs: int(process.env.AI_TIMEOUT_FAST_MS, Math.min(overall, 90_000)),
        temperature: num(process.env.AI_TEMPERATURE_FAST, 0.2),
        thinking: flag(process.env.AI_THINKING_FAST, false),
      },
      deep: {
        model,
        maxTokens: int(process.env.AI_MAX_TOKENS_DEEP, 6000),
        timeoutMs: int(process.env.AI_TIMEOUT_DEEP_MS, overall),
        temperature: num(process.env.AI_TEMPERATURE_DEEP, 0.3),
        thinking: flag(process.env.AI_THINKING_DEEP, false),
      },
      chat: {
        model,
        maxTokens: int(process.env.AI_MAX_TOKENS_CHAT, 4000),
        timeoutMs: int(process.env.AI_TIMEOUT_CHAT_MS, Math.min(overall, 90_000)),
        temperature: num(process.env.AI_TEMPERATURE_CHAT, 0.2),
        thinking: flag(process.env.AI_THINKING_CHAT, false),
      },
    };
  }
  return {
    fast: {
      model: process.env.AI_MODEL_FAST || 'claude-haiku-4-5',
      maxTokens: int(process.env.AI_MAX_TOKENS_FAST, 1200),
      timeoutMs: int(process.env.AI_TIMEOUT_FAST_MS, 20_000),
      effort: null, // Haiku 4.5 does not accept `effort`
    },
    deep: {
      model: process.env.AI_MODEL_DEEP || 'claude-sonnet-5-5',
      maxTokens: int(process.env.AI_MAX_TOKENS_DEEP, 6000),
      timeoutMs: int(process.env.AI_TIMEOUT_DEEP_MS, 90_000),
      effort: process.env.AI_EFFORT_DEEP || 'medium',
    },
    chat: {
      model: process.env.AI_MODEL_CHAT || 'claude-sonnet-5-5',
      maxTokens: int(process.env.AI_MAX_TOKENS_CHAT, 8000),
      timeoutMs: int(process.env.AI_TIMEOUT_CHAT_MS, 60_000),
      effort: process.env.AI_EFFORT_CHAT || 'medium',
    },
  };
}

/** Approximate $/1M tokens (Anthropic models), used only for the usage log. Keyed by model-id prefix. */
const PRICES = [
  { prefix: 'claude-haiku-4-5', input: 1, output: 5 },
  { prefix: 'claude-sonnet-5', input: 2, output: 10 },
  { prefix: 'claude-opus-5-5', input: 4, output: 20 },
  { prefix: 'claude-opus-5', input: 5, output: 25 },
];

function estimateCostUsd(model, usage) {
  if (!usage) return null;
  if (providerKind() === 'openai') {
    // Set AI_PRICE_INPUT_PER_M and AI_PRICE_OUTPUT_PER_M (USD per million tokens) to log a cost estimate.
    const priceIn = process.env.AI_PRICE_INPUT_PER_M;
    const priceOut = process.env.AI_PRICE_OUTPUT_PER_M;
    if (priceIn === undefined || priceOut === undefined) return null;
    return (((usage.input_tokens || 0) * num(priceIn, 0)) + ((usage.output_tokens || 0) * num(priceOut, 0))) / 1_000_000;
  }
  const p = PRICES.find((x) => String(model || '').startsWith(x.prefix));
  if (!p) return null;
  const input = (usage.input_tokens || 0) * p.input;
  const cacheRead = (usage.cache_read_input_tokens || 0) * p.input * 0.1;
  const cacheWrite = (usage.cache_creation_input_tokens || 0) * p.input * 1.25;
  const output = (usage.output_tokens || 0) * p.output;
  return (input + cacheRead + cacheWrite + output) / 1_000_000;
}

const limits = () => ({
  requestsPerMinute: int(process.env.AI_RPM_PER_USER, 10),
  tokensPerUserDay: int(process.env.AI_TOKENS_PER_USER_DAY, 300_000),
  tokensPerClientDay: int(process.env.AI_TOKENS_PER_CLIENT_DAY, 3_000_000),
});

/** How long an analysis for the same preset, dates and user is reused without even rebuilding it. */
const recentTtlSec = () => int(process.env.AI_ANALYSIS_TTL_SECONDS, 120);

const globalEnabled = () => process.env.AI_ENABLED === 'true';
/** Accounts with no explicit setting follow this default. */
const defaultEnabledForClients = () => process.env.AI_DEFAULT_ENABLED === 'true';

const hasCredentials = () => {
  if (providerKind() === 'openai') {
    return Boolean(process.env.AI_API_URL && process.env.AI_API_KEY && process.env.AI_MODEL);
  }
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
};

/** What the admin page may show about the active provider. Never includes the key. */
function providerInfo() {
  const kind = providerKind();
  const t = tiers();
  let host = 'api.anthropic.com';
  if (kind === 'openai') {
    try { host = new URL(process.env.AI_API_URL).host; } catch { host = 'unknown'; }
  }
  return {
    kind,
    host,
    credentials: hasCredentials(),
    models: { fast: t.fast.model, deep: t.deep.model, chat: t.chat.model },
    thinking: kind === 'openai' ? { fast: t.fast.thinking, deep: t.deep.thinking, chat: t.chat.thinking } : null,
    jsonMode: kind === 'openai' ? jsonModeEnabled() : null,
    timeoutsSec: { fast: Math.round(t.fast.timeoutMs / 1000), deep: Math.round(t.deep.timeoutMs / 1000), chat: Math.round(t.chat.timeoutMs / 1000) },
  };
}

module.exports = {
  providerInfo,
  jsonModeEnabled,
  providerKind,
  openaiEndpoint,
  tiers,
  limits,
  recentTtlSec,
  estimateCostUsd,
  globalEnabled,
  defaultEnabledForClients,
  hasCredentials,
};
