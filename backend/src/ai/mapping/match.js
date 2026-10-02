/**
 * Rule-based matching of Google Ads campaign names to the sites or apps they promote.
 * Pure functions, no I/O. A token that appears in many targets (a shared brand name) counts for
 * little; a token that appears in one target (quiz2, playskite) counts for a lot.
 */

/** Words that describe how a campaign is set up, not what it promotes. */
const STOP = new Set([
  'display', 'search', 'youtube', 'pmax', 'performance', 'max', 'campaign', 'campaigns', 'ads', 'ad',
  'app', 'apps', 'android', 'ios', 'universal', 'install', 'installs', 'brand', 'generic', 'remarketing',
  'retargeting', 'prospecting', 'include', 'exclude', 'target', 'targeting', 'test', 'copy', 'the', 'and',
  'for', 'ind', 'india', 'usa', 'can', 'aus', 'uae', 'country', 'countries', 'geo', 'tier',
]);

/** Generic web suffixes that say nothing about which site it is. */
const TLDS = new Set(['com', 'net', 'org', 'in', 'co', 'io', 'app', 'info', 'xyz', 'online', 'site', 'tv', 'me', 'us', 'uk', 'www']);
/** Words common in app ids that carry no identity. */
const APP_ID_NOISE = new Set(['com', 'org', 'net', 'app', 'android', 'ios', 'mobile']);

const MIN_TOKEN = 3;

function splitWords(str) {
  return String(str || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Words of a campaign name, without generic marketing words, countries and bare numbers. */
function campaignTokens(name) {
  const words = splitWords(name);
  const out = [];
  words.forEach((w, i) => {
    // "Quiz 13" reads as the single name quiz13.
    if (/^[a-z]{3,}$/.test(w) && /^\d{1,3}$/.test(words[i + 1] || '')) out.push(w + words[i + 1]);
    if (w.length < MIN_TOKEN || STOP.has(w) || /^\d+$/.test(w)) return;
    out.push(w);
  });
  return [...new Set(out)];
}

const stripDigits = (t) => t.replace(/\d+$/, '');

/** Identity words of a site host: labels without www or the TLD; a trailing number also gives the bare word. */
function hostTokens(host) {
  const labels = String(host || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').split('.').filter(Boolean);
  while (labels.length > 1 && TLDS.has(labels[labels.length - 1])) labels.pop();
  const out = [];
  for (const label of labels) {
    if (TLDS.has(label) || label.length < MIN_TOKEN) continue;
    out.push(label);
    const bare = stripDigits(label);
    if (bare !== label && bare.length >= MIN_TOKEN) out.push(bare);
  }
  return [...new Set(out)];
}

/** Identity words of an app: its display name plus the parts of its store id. */
function appTokens(name, storeId) {
  const out = campaignTokens(name);
  for (const part of String(storeId || '').toLowerCase().split('.')) {
    if (part.length >= MIN_TOKEN && !APP_ID_NOISE.has(part)) out.push(part);
  }
  return [...new Set(out)];
}

function tokensForTarget(target) {
  return target.type === 'site' ? hostTokens(target.key) : appTokens(target.label, target.key);
}

/** Edit-distance similarity from 0 to 1. */
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** How strongly a campaign token points at a target token: 1 exact, less for containment or a near spelling. */
function tokenMatch(campaignToken, targetToken, compactName) {
  if (campaignToken === targetToken) return 1;
  // quiz13 and quiz1 are different things even though one contains the other.
  const cNum = (campaignToken.match(/\d+$/) || [''])[0];
  const tNum = (targetToken.match(/\d+$/) || [''])[0];
  if (cNum && tNum && cNum !== tNum) return 0;
  // The name contains the target, but "quiz1" must not be found inside "quiz13".
  if (targetToken.length >= 5 && compactName.includes(targetToken)
    && !(/\d$/.test(targetToken) && new RegExp(targetToken + '\\d').test(compactName))) return 0.9;
  if (campaignToken.length >= 4 && targetToken.length >= 6 && targetToken.startsWith(campaignToken)) return 0.7;
  if (campaignToken.length >= 5 && targetToken.length >= 5) {
    if (targetToken.includes(campaignToken) || campaignToken.includes(targetToken)) return 0.8;
    if (similarity(campaignToken, targetToken) >= 0.84) return 0.75;
  }
  return 0;
}

/**
 * Build a scorer for one pool of targets.
 * @param {{type: 'site'|'app', key: string, label: string}[]} targets
 */
function buildMatcher(targets) {
  const prepared = targets.map((t) => ({ target: t, tokens: tokensForTarget(t) }));
  const df = new Map();
  for (const p of prepared) for (const t of new Set(p.tokens)) df.set(t, (df.get(t) || 0) + 1);
  const n = Math.max(1, prepared.length);
  // A token in every target has weight near 0.2; one in a single target has the highest weight.
  const weight = (t) => Math.max(0.2, Math.log((n + 1) / ((df.get(t) || 0) + 0.5)));

  /** Best targets for a campaign name: [{ target, score }] sorted high to low, scores 0 to 1. */
  function rank(campaignName, limit = 6) {
    const cTokens = campaignTokens(campaignName);
    const compact = cTokens.join('');
    const scored = [];
    for (const p of prepared) {
      if (!p.tokens.length) continue;
      let hit = 0;
      let total = 0;
      for (const t of p.tokens) {
        const w = weight(t);
        total += w;
        let best = 0;
        for (const c of cTokens) best = Math.max(best, tokenMatch(c, t, compact));
        hit += w * best;
      }
      const score = total > 0 ? hit / total : 0;
      if (score > 0) scored.push({ target: p.target, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  return { rank };
}

/** high: one clear winner. medium: a likely winner. low: needs a closer look. */
function confidenceFor(ranked) {
  const top = ranked[0];
  if (!top) return 'none';
  const second = ranked[1]?.score || 0;
  const margin = top.score - second;
  if (top.score >= 0.7 && margin >= 0.3) return 'high';
  if (top.score >= 0.45 && margin >= 0.15) return 'medium';
  return 'low';
}

/** Campaign words that point at the target (for the reason shown to the user). */
function sharedTokens(campaignName, target) {
  const cTokens = campaignTokens(campaignName);
  const compact = cTokens.join('');
  const hits = tokensForTarget(target).filter((t) => cTokens.some((c) => tokenMatch(c, t, compact) > 0));
  // When "quiz13" matched, listing "quiz" as well adds nothing.
  return hits.filter((t) => !hits.some((o) => o !== t && o.length > t.length && o.startsWith(t)));
}

module.exports = {
  sharedTokens,
  campaignTokens, hostTokens, appTokens, buildMatcher, confidenceFor, similarity,
};
