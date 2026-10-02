/**
 * Checks campaign-mapping suggestions and alerts against the local database, with a stand-in model.
 * Adds temporary Google Ads rows to a workspace and removes them again.
 *
 *   npm run test:ai   (runs this and test-ai-preset-analysis.js)
 */
process.env.REDIS_DISABLED = process.env.REDIS_DISABLED || 'true';
process.env.AI_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'test-key';
// These checks drive the Anthropic-shaped test client, whatever the .env says.
process.env.AI_PROVIDER = 'anthropic';

const assert = require('assert');
const crypto = require('crypto');
const db = require('../src/db');
const { query } = require('../src/db');
const { createUser, deleteUser, getUserById } = require('../src/models/userStore');
const { rotateUserSession } = require('../src/utils/sessionManager');
const { generateTokens } = require('../src/middleware/auth');
const { runWithClient } = require('../src/utils/clientContext');
const provider = require('../src/ai/provider');
const match = require('../src/ai/mapping/match');
const { suggestMappings } = require('../src/ai/mapping');
const presetAnalysis = require('../src/ai/presetAnalysis');
const { FactBook } = require('../src/ai/presetAnalysis/factBook');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// ── pure matcher ──────────────────────────────────────────────────────────────────────────
check('matcher: clear names are likely, numbers must agree, noise is ignored', async () => {
  const sites = ['quiz1.brainfungames.com', 'quiz2.brainfungames.com', 'quiz13.arenapro6.com', 'arenapro6.com', 'playskite.com']
    .map((k) => ({ type: 'site', key: k, label: k }));
  const m = match.buildMatcher(sites);
  const top = (name) => m.rank(name, 3)[0];
  assert.strictEqual(top('Playskite - Display - US').target.key, 'playskite.com');
  assert.strictEqual(match.confidenceFor(m.rank('Playskite - Display - US')), 'high');
  assert.strictEqual(top('Quiz 13 - Display').target.key, 'quiz13.arenapro6.com', 'quiz13 is not quiz1');
  assert.strictEqual(top('Quiz2 Search IN').target.key, 'quiz2.brainfungames.com');
  assert.strictEqual(m.rank('Totally Unrelated Thing').length, 0);
  assert.strictEqual(match.confidenceFor(m.rank('BrainFun Games - Search')), 'low', 'a brand shared by many sites is not decisive');
});

// ── suggestions against a real workspace ───────────────────────────────────────────────────
let aiCalls = 0;
function installFakeModel() {
  provider.setClientForTests({
    messages: {
      stream(params) {
        aiCalls += 1;
        const payload = JSON.parse(params.messages[0].content.replace('Campaigns:\n', ''));
        const json = JSON.stringify({
          matches: payload.map((c) => ({
            index: c.index,
            // pick a real candidate for "brainfun"; answer with a key that is not a candidate otherwise
            targetKey: /brainfun/i.test(c.campaign) ? c.candidates[0].key : 'not-a-candidate.example',
            confidence: 'medium',
            reason: 'Stand-in reason.',
          })),
        });
        const h = {};
        const s = {
          on(ev, cb) { h[ev] = cb; return s; },
          async finalMessage() {
            h.text?.(json);
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: json }], usage: { input_tokens: 400, output_tokens: 60 } };
          },
        };
        return s;
      },
    },
  });
}

async function withFixtures(fn) {
  const { rows } = await db.schemaQuery(
    `SELECT c.id AS ws
     FROM gam_clients c JOIN adsense_accounts a ON a.client_id = c.id
     WHERE c.publisher_parent_id IS NOT NULL LIMIT 1`
  );
  if (!rows[0]) throw new Error('No AdSense workspace in this database to test against');
  const { ws } = rows[0];
  const wsClient = { id: ws };
  const exec = (sql, p) => runWithClient(wsClient, () => query(sql, p));
  const acct = crypto.randomUUID();
  const userId = `user-aitest-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  try {
    await exec(`INSERT INTO ads_accounts (id, client_id, account_type, customer_id, descriptive_name) VALUES ($1,$2,'client',$3,'AI test account')`, [acct, ws, `aitest-${Date.now()}`]);
    const campaign = (id, name, cost, appId = '') => exec(
      `INSERT INTO ads_spend_daily (client_id, ads_account_id, report_date, campaign_id, campaign_name, app_id, cost, currency)
       VALUES ($1,$2,current_date - 3,$3,$4,$5,$6,'USD')`,
      [ws, acct, id, name, appId, cost]
    );
    await campaign('t1', 'Quiz2 - Search - IN', 120);
    await campaign('t2', 'BrainFun Games - Search - IN', 60);
    await campaign('t3', 'Totally Unrelated Thing', 40);
    await campaign('t4', 'App campaign with store id', 500, 'com.some.app');
    await campaign('t5', 'Quiz1 - Display (already mapped)', 70);
    await exec(
      `INSERT INTO ads_campaign_map (id, client_id, ads_account_id, campaign_id, campaign_name, target_type, target_key) VALUES ($1,$2,$3,'t5','x','site','quiz1.brainfungames.com')`,
      [crypto.randomUUID(), ws, acct]
    );
    await createUser({ id: userId, username: `aitest_${userId.slice(-8)}`, password: 'Test#12345x', role: 'admin', permissions: {}, clientId: ws });
    const sid = await rotateUserSession(userId, {});
    const user = await getUserById(userId);
    const { accessToken } = generateTokens(user, sid);
    await fn({ ws, wsClient, acct, user, authorization: `Bearer ${accessToken}` });
  } finally {
    await exec('DELETE FROM ads_campaign_map WHERE ads_account_id = $1', [acct]).catch(() => {});
    await exec('DELETE FROM ads_spend_daily WHERE ads_account_id = $1', [acct]).catch(() => {});
    await exec('DELETE FROM ads_accounts WHERE id = $1', [acct]).catch(() => {});
    await deleteUser(userId).catch(() => {});
    await db.schemaQuery(`DELETE FROM ai_usage_log WHERE user_id = $1`, [userId]).catch(() => {});
  }
}

check('suggestions: only unmapped site campaigns, rules first, model only for unclear ones', async () => {
  await withFixtures(async ({ wsClient, acct, user, authorization }) => {
    const base = { product: 'adsense', client: wsClient, adsAccountId: acct, authorization };
    const rules = await runWithClient(wsClient, () => suggestMappings({ ...base, ai: null }));
    const names = rules.suggestions.map((s) => s.campaignName);
    assert.deepStrictEqual(names.sort(), ['BrainFun Games - Search - IN', 'Quiz2 - Search - IN', 'Totally Unrelated Thing'].sort(),
      'mapped and app-id campaigns are left out');
    const quiz = rules.suggestions.find((s) => s.campaignName.startsWith('Quiz2'));
    assert.strictEqual(quiz.target.key, 'quiz2.brainfungames.com');
    assert.strictEqual(quiz.confidence, 'high');
    assert.strictEqual(rules.stats.ai.used, false);

    const before = aiCalls;
    const withAi = await runWithClient(wsClient, () => suggestMappings({ ...base, ai: { userId: user.id, clientId: user.clientId } }));
    assert.strictEqual(aiCalls, before + 1, 'one batched model call');
    const asked = withAi.stats.ai.asked;
    assert.ok(asked >= 1 && asked <= 2, 'only unclear campaigns are sent');
    const brainfun = withAi.suggestions.find((s) => s.campaignName.startsWith('BrainFun'));
    assert.strictEqual(brainfun.source, 'ai');
    assert.ok(brainfun.target, 'AI picked one of the candidates');
    const unrelated = withAi.suggestions.find((s) => s.campaignName.startsWith('Totally'));
    assert.strictEqual(unrelated.target, null, 'no candidates means no guess');
    // The model returned a key that was not a candidate for the clear match: the rule result must stand.
    assert.strictEqual(withAi.suggestions.find((s) => s.campaignName.startsWith('Quiz2')).target.key, 'quiz2.brainfungames.com');

    await runWithClient(wsClient, () => suggestMappings({ ...base, ai: { userId: user.id, clientId: user.clientId } }));
    assert.strictEqual(aiCalls, before + 1, 'identical questions are answered from the cache');
  });
});

// ── alerts ────────────────────────────────────────────────────────────────────────────────
check('alerts: raised once, ordered, capped, dismissable', async () => {
  await withFixtures(async ({ user, authorization }) => {
    const real = presetAnalysis.buildFacts;
    let accountId = null;
    let n = 0;
    presetAnalysis.buildFacts = async ({ body }) => {
      const book = new FactBook('USD');
      const id = book.add('Estimated earnings', 100, 'money', { change: -40 });
      const mk = (severity, kind, title) => ({ severity, kind, title, text: `${title}.`, factIds: [id], priority: 1, action: null });
      return {
        request: body,
        final: {
          book,
          signals: [
            mk('warning', 'metric_drop', `Earnings are down ${30 + n}%`),
            mk('critical', 'negative_roi', `ROI is -${20 + n}%: spend exceeds earnings`),
            mk('positive', 'metric_rise', 'Earnings are up 50%'),
            mk('warning', 'concentration', 'One site carries 60%'),
          ],
        },
      };
    };
    try {
      delete require.cache[require.resolve('../src/ai/alerts')];
      const alerts = require('../src/ai/alerts');
      accountId = await alerts.accountIdFor(user);
      await db.schemaQuery('DELETE FROM ai_alerts WHERE account_id = $1', [accountId]);
      const first = await alerts.scanAccount({ user, authorization });
      assert.strictEqual(first.created, 10, 'capped at 10 per scan');
      let list = await alerts.listAlerts(accountId);
      assert.strictEqual(list[0].severity, 'critical', 'critical first');
      assert.ok(!list.some((a) => ['metric_rise', 'concentration'].includes(a.kind)), 'good news and concentration are not alerts');

      n = 5; // same problems, different numbers
      const second = await alerts.scanAccount({ user, authorization });
      assert.strictEqual(second.created, 2, 'only the targets that were cut off by the cap are new');
      assert.strictEqual((await alerts.listAlerts(accountId)).length, 12);

      assert.strictEqual(await alerts.dismissAlert(accountId, list[0].id, user.id), true);
      assert.strictEqual(await alerts.dismissAlert('another-account', list[1].id, user.id), false, 'cannot dismiss another account\'s alert');
      list = await alerts.listAlerts(accountId);
      assert.strictEqual(list.length, 11);
      assert.strictEqual(await alerts.isScanDue(accountId), false, 'cooldown after a scan');
    } finally {
      presetAnalysis.buildFacts = real;
      if (accountId) await db.schemaQuery('DELETE FROM ai_alerts WHERE account_id = $1', [accountId]);
    }
  });
});

(async () => {
  installFakeModel();
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
