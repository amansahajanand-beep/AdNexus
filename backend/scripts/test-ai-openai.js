/**
 * Checks the OpenAI-style provider (NVIDIA Nemotron and similar) against a fake endpoint: message and tool
 * translation, streaming, hidden reasoning, retries, error handling and the request options it sends.
 * No network and no API key needed.
 *
 *   npm run test:ai   (runs this with the other AI checks)
 */
process.env.REDIS_DISABLED = process.env.REDIS_DISABLED || 'true';
process.env.AI_PROVIDER = 'openai';
process.env.AI_API_URL = 'https://example.invalid/v1/chat/completions';
process.env.AI_API_KEY = 'test-key';
process.env.AI_MODEL = 'test/model';
delete process.env.AI_THINKING_DEEP;
delete process.env.AI_JSON_MODE;

const assert = require('assert');
const provider = require('../src/ai/provider');
const openai = require('../src/ai/providers/openaiCompat');
const config = require('../src/ai/config');

const requests = [];
let script = [];

const enc = new TextEncoder();
/** A streamed reply. `parts` are strings or objects (sent as data frames); split cuts the bytes mid-frame. */
function sse(parts, { split = 0 } = {}) {
  const text = parts.map((p) => (typeof p === 'string' ? p : `data: ${JSON.stringify(p)}\n\n`)).join('');
  const bytes = enc.encode(text);
  const chunks = split ? [bytes.slice(0, split), bytes.slice(split)] : [bytes];
  return new Response(new ReadableStream({
    start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const delta = (d, finish = null, extra = {}) => ({ id: 'x', choices: [{ index: 0, delta: d, finish_reason: finish }], ...extra });
const DONE = 'data: [DONE]\n\n';
const usageFrame = { id: 'x', choices: [], usage: { prompt_tokens: 111, completion_tokens: 22 } };
const text = (t) => [delta({ role: 'assistant', content: t }), delta({}, 'stop'), usageFrame, DONE];

openai.setFetchForTests(async (url, init) => {
  requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  const next = script.shift();
  if (!next) throw new Error('unexpected request');
  if (next instanceof Error) throw next;
  return typeof next === 'function' ? next() : next;
});

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const reset = () => { requests.length = 0; script = []; openai.resetQuirks(); };

check('config: picks the OpenAI-style provider from AI_API_URL and keeps thinking off by default', async () => {
  assert.strictEqual(config.providerKind(), 'openai');
  assert.ok(config.hasCredentials());
  const t = config.tiers();
  assert.strictEqual(t.fast.model, 'test/model');
  assert.strictEqual(t.fast.thinking, false);
  assert.strictEqual(t.deep.thinking, false);
  assert.strictEqual(config.jsonModeEnabled(), false);
  process.env.AI_PROVIDER = 'anthropic';
  assert.strictEqual(config.providerKind(), 'anthropic');
  process.env.AI_PROVIDER = '';
  assert.strictEqual(config.providerKind(), 'openai', 'auto-detected when AI_PROVIDER is empty');
  process.env.AI_PROVIDER = 'openai';
});

check('run: sends the right request and streams text, ignoring private reasoning', async () => {
  reset();
  script = [sse([
    delta({ role: 'assistant', reasoning_content: 'secret thoughts ' }),
    delta({ content: '<think>hidden ' }), delta({ content: 'more</think>' }), delta({ content: 'Hello ' }), delta({ content: 'there' }),
    delta({}, 'stop'), usageFrame, DONE,
  ], { split: 37 })];
  const seen = [];
  const r = await provider.run({ feature: 't', tier: 'fast', system: 'SYS', user: 'hi', onText: (c) => seen.push(c) });
  assert.strictEqual(r.text, 'Hello there');
  assert.strictEqual(seen.join(''), 'Hello there', 'only the answer is streamed');
  assert.deepStrictEqual(r.usage, { input_tokens: 111, output_tokens: 22 });
  const { body, headers, url } = requests[0];
  assert.strictEqual(url, 'https://example.invalid/v1/chat/completions');
  assert.strictEqual(headers.Authorization, 'Bearer test-key');
  assert.strictEqual(body.model, 'test/model');
  assert.strictEqual(body.stream, true);
  assert.deepStrictEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.strictEqual(body.response_format, undefined, 'JSON mode is off by default (it stops streaming)');
  assert.deepStrictEqual(body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]);
});

check('run: structured output is requested in the prompt and parsed out of fenced text', async () => {
  reset();
  script = [sse(text('Sure!\n```json\n{"headline":"H","n":2}\n```'))];
  const schema = { type: 'object', properties: { headline: { type: 'string' } } };
  const r = await provider.run({ feature: 't', tier: 'fast', system: 'SYS', user: 'x', outputSchema: schema });
  assert.deepStrictEqual(r.json, { headline: 'H', n: 2 });
  assert.match(requests[0].body.messages[0].content, /JSON Schema/);
  assert.ok(requests[0].body.messages[0].content.includes('"headline"'));
  script = [sse(text('not json at all'))];
  await assert.rejects(() => provider.run({ feature: 't', tier: 'fast', system: 'S', user: 'x', outputSchema: schema }), (e) => e.code === 'ai_bad_output');
});

check('run: thinking and JSON mode are opt-in', async () => {
  reset();
  process.env.AI_THINKING_DEEP = 'true';
  process.env.AI_JSON_MODE = 'true';
  try {
    script = [sse(text('{"a":1}'))];
    await provider.run({ feature: 't', tier: 'deep', system: 'S', user: 'x', outputSchema: { type: 'object' } });
    assert.deepStrictEqual(requests[0].body.chat_template_kwargs, { enable_thinking: true });
    assert.deepStrictEqual(requests[0].body.response_format, { type: 'json_object' });
  } finally {
    delete process.env.AI_THINKING_DEEP;
    delete process.env.AI_JSON_MODE;
  }
});

check('runTurn: assembles parallel tool calls from fragments and maps stop reasons', async () => {
  reset();
  script = [sse([
    delta({ role: 'assistant', content: '\n' }),
    delta({ tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'get_summary', arguments: '{"product":' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'call-b', type: 'function', function: { name: 'find_filter_values', arguments: '{"product":"adsense"}' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '"adsense","start_date":"2026-09-24","end_date":"2026-09-30"}' } }] }),
    delta({}, 'tool_calls'), usageFrame, DONE,
  ])];
  const { message } = await provider.runTurn({
    feature: 't', tier: 'chat', system: 'S', messages: [{ role: 'user', content: 'q' }],
    tools: [{ name: 'get_summary', description: 'd', eager_input_streaming: true, input_schema: { type: 'object', properties: {} } }],
  });
  assert.strictEqual(message.stop_reason, 'tool_use');
  const uses = message.content.filter((b) => b.type === 'tool_use');
  assert.deepStrictEqual(uses.map((u) => [u.id, u.name]), [['call-a', 'get_summary'], ['call-b', 'find_filter_values']]);
  assert.deepStrictEqual(uses[0].input, { product: 'adsense', start_date: '2026-09-24', end_date: '2026-09-30' });
  const sent = requests[0].body;
  assert.strictEqual(sent.tool_choice, 'auto');
  assert.deepStrictEqual(sent.tools[0], { type: 'function', function: { name: 'get_summary', description: 'd', parameters: { type: 'object', properties: {} } } });

  script = [sse([delta({ content: 'cut' }, 'length'), DONE])];
  const cut = await provider.runTurn({ feature: 't', tier: 'chat', system: 'S', messages: [{ role: 'user', content: 'q' }] });
  assert.strictEqual(cut.message.stop_reason, 'max_tokens');
  script = [sse([delta({}, 'content_filter'), DONE])];
  const blocked = await provider.runTurn({ feature: 't', tier: 'chat', system: 'S', messages: [{ role: 'user', content: 'q' }] });
  assert.strictEqual(blocked.message.stop_reason, 'refusal');
});

check('runTurn: tool calls and results are translated to chat-completions messages', async () => {
  reset();
  script = [sse(text('Done.'))];
  await provider.runTurn({
    feature: 't', tier: 'chat', system: 'S',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking' }, { type: 'tool_use', id: 'c1', name: 'get_summary', input: { product: 'gam' } }, { type: 'tool_use', id: 'c2', name: 'get_breakdown', input: { x: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"ok":true}' }, { type: 'tool_result', tool_use_id: 'c2', is_error: true, content: 'bad input' }, { type: 'text', text: 'last call allowed' }] },
    ],
  });
  const m = requests[0].body.messages;
  assert.deepStrictEqual(m[2], {
    role: 'assistant',
    content: 'Checking',
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'get_summary', arguments: '{"product":"gam"}' } },
      { id: 'c2', type: 'function', function: { name: 'get_breakdown', arguments: '{"x":1}' } },
    ],
  });
  assert.deepStrictEqual(m[3], { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' });
  assert.deepStrictEqual(m[4], { role: 'tool', tool_call_id: 'c2', content: 'Error: bad input' });
  assert.deepStrictEqual(m[5], { role: 'user', content: 'last call allowed' });
});

check('runTurn: an unreadable tool call is a bad-output error the chat can retry', async () => {
  reset();
  script = [sse([delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'get_summary', arguments: '{"product": ' } }] }), delta({}, 'tool_calls'), DONE])];
  await assert.rejects(
    () => provider.runTurn({ feature: 't', tier: 'chat', system: 'S', messages: [{ role: 'user', content: 'q' }] }),
    (e) => e.code === 'ai_bad_output'
  );
});

check('retries: an error inside a 200 stream, an empty stream and HTTP 503 are retried', async () => {
  reset();
  script = [
    sse([{ error: { message: 'Service temporarily overloaded', type: 'service_unavailable', code: 503 } }, DONE]),
    sse([DONE]),
    new Response('upstream down', { status: 503 }),
  ];
  await assert.rejects(() => provider.run({ feature: 't', tier: 'fast', system: 'S', user: 'x' }), (e) => e.code === 'ai_upstream_error' && e.status === 503);
  assert.strictEqual(requests.length, 3, 'three attempts, then give up');

  reset();
  script = [sse([{ error: { message: 'Service temporarily overloaded', type: 'service_unavailable', code: 503 } }, DONE]), sse(text('Second time lucky'))];
  const r = await provider.run({ feature: 't', tier: 'fast', system: 'S', user: 'x' });
  assert.strictEqual(r.text, 'Second time lucky');
  assert.strictEqual(requests.length, 2);

  reset();
  script = [new Response('slow down', { status: 429 }), sse(text('ok'))];
  assert.strictEqual((await provider.run({ feature: 't', tier: 'fast', system: 'S', user: 'x' })).text, 'ok');
  reset();
  script = [new TypeError('fetch failed'), sse(text('after network blip'))];
  assert.strictEqual((await provider.run({ feature: 't', tier: 'fast', system: 'S', user: 'x' })).text, 'after network blip');
});

check('retries: nothing is retried once text has already been shown', async () => {
  reset();
  script = [sse([delta({ content: 'Partial ' }), { error: { message: 'Service temporarily overloaded', type: 'service_unavailable', code: 503 } }, DONE]), sse(text('would duplicate'))];
  const seen = [];
  await assert.rejects(() => provider.run({ feature: 't', tier: 'fast', system: 'S', user: 'x', onText: (c) => seen.push(c) }), (e) => e.code === 'ai_upstream_error');
  assert.strictEqual(requests.length, 1);
  assert.deepStrictEqual(seen, ['Partial ']);
});

check('errors: bad credentials and rejected requests are not retried and say so plainly', async () => {
  reset();
  script = [new Response('{"detail":"Unauthorized"}', { status: 401 })];
  await assert.rejects(() => provider.run({ feature: 't', tier: 'fast', system: 'S', user: 'x' }), (e) => e.code === 'ai_upstream_error' && /not configured/.test(e.message));
  assert.strictEqual(requests.length, 1);
  reset();
  script = [new Response('{"detail":"bad"}', { status: 400 })];
  await assert.rejects(() => provider.run({ feature: 't', tier: 'fast', system: 'S', user: 'x' }), (e) => /rejected/.test(e.message));
  assert.strictEqual(requests.length, 1);
});

check('compat: an endpoint that rejects chat_template_kwargs or response_format is retried without them', async () => {
  reset();
  process.env.AI_JSON_MODE = 'true';
  try {
    script = [
      new Response('{"error":"unknown field chat_template_kwargs"}', { status: 400 }),
      new Response('{"error":"response_format not supported"}', { status: 400 }),
      sse(text('{"a":1}')),
    ];
    const r = await provider.run({ feature: 't', tier: 'fast', system: 'S', user: 'x', outputSchema: { type: 'object' } });
    assert.deepStrictEqual(r.json, { a: 1 });
    assert.strictEqual(requests.length, 3);
    assert.strictEqual(requests[2].body.chat_template_kwargs, undefined);
    assert.strictEqual(requests[2].body.response_format, undefined);
    // remembered for later calls
    script = [sse(text('ok'))];
    await provider.run({ feature: 't', tier: 'fast', system: 'S', user: 'x' });
    assert.strictEqual(requests[3].body.chat_template_kwargs, undefined);
  } finally {
    delete process.env.AI_JSON_MODE;
  }
});

check('think filter: tags split across chunks and unterminated blocks never leak', async () => {
  const f = new openai.ThinkFilter();
  const out = ['<thi', 'nk>secret', ' stuff</th', 'ink>Visible', ' <b>text</b>'].map((c) => f.push(c)).join('') + f.flush();
  assert.strictEqual(out, 'Visible <b>text</b>');
  const g = new openai.ThinkFilter();
  assert.strictEqual(g.push('<think>never closed') + g.flush(), '');
  const h = new openai.ThinkFilter();
  assert.strictEqual(h.push('a < b and 5 <') + h.flush(), 'a < b and 5 <');
});

(async () => {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.fn();
      console.log(`ok   ${c.name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${c.name}\n     ${err.message}`);
    }
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
