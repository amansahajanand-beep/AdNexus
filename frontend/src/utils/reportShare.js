const LIST_KEYS = ['domain', 'site', 'domainName', 'domainId', 'country', 'dims', 'mets'];

function toList(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v.filter(Boolean).map(String) : [String(v)];
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
} = {}) {
  const p = new URLSearchParams();
  if (preset) p.set('preset', String(preset));
  if (startDate) p.set('from', String(startDate));
  if (endDate) p.set('to', String(endDate));
  toList(domain).forEach((v) => p.append('domain', v));
  toList(site).forEach((v) => p.append('site', v));
  toList(domainName).forEach((v) => p.append('domainName', v));
  toList(domainId).forEach((v) => p.append('domainId', v));
  toList(country).forEach((v) => p.append('country', v));
  toList(reportDimensions).forEach((v) => p.append('dims', v));
  toList(reportMetrics).forEach((v) => p.append('mets', v));
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
  const parsed = {
    preset: preset || null,
    startDate: from || null,
    endDate: to || null,
    domain: getAll('domain'),
    site: getAll('site'),
    domainName: getAll('domainName'),
    domainId: getAll('domainId'),
    country: getAll('country'),
    reportDimensions: getAll('dims'),
    reportMetrics: getAll('mets'),
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
    };
    return map[k]?.length;
  });
  if (!parsed.preset && !parsed.startDate && !hasList) return null;
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
