const LIST_KEYS = [
  'domain', 'site', 'domainName', 'domainId', 'country', 'dims', 'mets',
  'accountIds', 'campaignIds', 'appKeys', 'siteKeys', 'countryCodes',
];

function toList(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v.filter(Boolean).map(String) : [String(v)];
}

function appendCsv(p, key, values) {
  const list = toList(values).filter((v) => v && v !== '__ALL__');
  if (!list.length) return;
  p.set(key, list.join(','));
}

function parseCsvParam(searchParams, key) {
  const raw = searchParams.get?.(key) || '';
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Serialize current report/dashboard filters into a query string (no leading ?). */
export function encodeReportShare({
  preset,
  startDate,
  endDate,
  domain,
  site,
  domainName,
  domainId,
  country,
  reportDimensions,
  reportMetrics,
  targetType,
  accountIds,
  campaignIds,
  appKeys,
  siteKeys,
  countryCodes,
} = {}) {
  const p = new URLSearchParams();
  if (preset) p.set('preset', String(preset));
  if (startDate) p.set('from', String(startDate));
  if (endDate) p.set('to', String(endDate));
  if (targetType && targetType !== 'all') p.set('targetType', String(targetType));
  toList(domain).forEach((v) => p.append('domain', v));
  toList(site).forEach((v) => p.append('site', v));
  toList(domainName).forEach((v) => p.append('domainName', v));
  toList(domainId).forEach((v) => p.append('domainId', v));
  toList(country).forEach((v) => p.append('country', v));
  toList(reportDimensions).forEach((v) => p.append('dims', v));
  toList(reportMetrics).forEach((v) => p.append('mets', v));
  appendCsv(p, 'accountIds', accountIds);
  appendCsv(p, 'campaignIds', campaignIds);
  appendCsv(p, 'appKeys', appKeys);
  appendCsv(p, 'siteKeys', siteKeys);
  appendCsv(p, 'countryCodes', countryCodes);
  return p.toString();
}

export function parseReportShare(searchParams) {
  if (!searchParams) return null;
  const getAll = (key) => {
    if (typeof searchParams.getAll === 'function') return searchParams.getAll(key).filter(Boolean);
    const v = searchParams.get?.(key);
    return v ? [v] : [];
  };
  const preset = searchParams.get?.('preset') || '';
  const from = searchParams.get?.('from') || '';
  const to = searchParams.get?.('to') || '';
  const targetTypeRaw = searchParams.get?.('targetType') || '';
  const targetType = ['site', 'app', 'all'].includes(targetTypeRaw) ? targetTypeRaw : null;
  const parsed = {
    preset: preset || null,
    startDate: from || null,
    endDate: to || null,
    targetType,
    domain: getAll('domain'),
    site: getAll('site'),
    domainName: getAll('domainName'),
    domainId: getAll('domainId'),
    country: getAll('country'),
    reportDimensions: getAll('dims'),
    reportMetrics: getAll('mets'),
    accountIds: parseCsvParam(searchParams, 'accountIds'),
    campaignIds: parseCsvParam(searchParams, 'campaignIds'),
    appKeys: parseCsvParam(searchParams, 'appKeys'),
    siteKeys: parseCsvParam(searchParams, 'siteKeys'),
    countryCodes: parseCsvParam(searchParams, 'countryCodes'),
  };
  const hasList = LIST_KEYS.some((k) => {
    const map = {
      domain: parsed.domain,
      site: parsed.site,
      domainName: parsed.domainName,
      domainId: parsed.domainId,
      country: parsed.country,
      dims: parsed.reportDimensions,
      mets: parsed.reportMetrics,
      accountIds: parsed.accountIds,
      campaignIds: parsed.campaignIds,
      appKeys: parsed.appKeys,
      siteKeys: parsed.siteKeys,
      countryCodes: parsed.countryCodes,
    };
    return map[k]?.length;
  });
  if (!parsed.preset && !parsed.startDate && !hasList && !parsed.targetType) return null;
  return parsed;
}

export async function copyReportLink(payload) {
  const qs = encodeReportShare(payload);
  const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    return url;
  } catch {
    return url;
  }
}
