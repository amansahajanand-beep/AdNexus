import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adInsightsAPI } from '../utils/api';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import './AdInsights.css';

const RANGES = [
  { days: 7, label: '7D' },
  { days: 14, label: '14D' },
  { days: 30, label: '30D' },
  { days: 90, label: '90D' },
];

const TABS = [
  { id: 'assets', label: 'Assets' },
  { id: 'keywords', label: 'Keywords' },
  { id: 'terms', label: 'Search terms' },
];

const ASSET_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'headline', label: 'Headlines' },
  { id: 'description', label: 'Descriptions' },
];

const LABEL_META = {
  BEST: { text: 'Best', tone: 'best' },
  GOOD: { text: 'Good', tone: 'good' },
  LEARNING: { text: 'Learning', tone: 'learning' },
  LOW: { text: 'Low', tone: 'low' },
  PENDING: { text: 'Pending', tone: 'muted' },
};

const STOP_WORDS = new Set((
  'a an and are as at be but by for from has have i if in into is it its of on or our so that the their then there '
  + 'these this to up us we with you your now get new more free best all any can will just not no out one'
).split(' '));

const nf = new Intl.NumberFormat();
const nfCompact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function money(value, currency) {
  const v = Number(value) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: v >= 100 ? 0 : 2,
    }).format(v);
  } catch {
    return v.toFixed(2);
  }
}

const pct = (v) => `${((Number(v) || 0) * 100).toFixed(2)}%`;
const compact = (v) => nfCompact.format(Number(v) || 0);

function assetKind(a) {
  if (a.fieldType === 'HEADLINE' || a.fieldType === 'LONG_HEADLINE') return 'headline';
  if (a.fieldType === 'DESCRIPTION') return 'description';
  if (a.youtubeId || a.type === 'YOUTUBE_VIDEO' || a.type === 'MEDIA_BUNDLE') return 'video';
  if (a.imageUrl || a.type === 'IMAGE') return 'image';
  return a.text ? 'description' : 'image';
}

function prettyField(f) {
  return String(f || '').toLowerCase().replace(/_/g, ' ');
}

function sumTotals(list) {
  const t = { impressions: 0, clicks: 0, cost: 0, conversions: 0 };
  list.forEach((x) => {
    t.impressions += x.impressions || 0;
    t.clicks += x.clicks || 0;
    t.cost += x.cost || 0;
    t.conversions += x.conversions || 0;
  });
  return {
    ...t,
    ctr: t.impressions ? t.clicks / t.impressions : 0,
    cpa: t.conversions ? t.cost / t.conversions : 0,
  };
}

function storeLabel(store) {
  if (store === 'GOOGLE_APP_STORE') return 'Google Play';
  if (store === 'APPLE_APP_STORE') return 'App Store';
  return null;
}

/* ───────────── small presentational pieces ───────────── */

function Kpi({ label, value, hint }) {
  return (
    <div className="ai-kpi">
      <div className="ai-kpi-label">{label}</div>
      <div className="ai-kpi-value">{value}</div>
      {hint ? <div className="ai-kpi-hint">{hint}</div> : null}
    </div>
  );
}

function LabelBadge({ label }) {
  const meta = LABEL_META[label];
  if (!meta) return null;
  return <span className={`ai-badge ai-badge--${meta.tone}`}>{meta.text}</span>;
}

function Skeleton({ rows = 6 }) {
  return (
    <div className="ai-grid">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="ai-card ai-skeleton" />
      ))}
    </div>
  );
}

function EmptyState({ title, children }) {
  return (
    <div className="ai-empty">
      <div className="ai-empty-title">{title}</div>
      {children ? <div className="ai-empty-body">{children}</div> : null}
    </div>
  );
}

function Metrics({ t, currency }) {
  return (
    <div className="ai-metrics">
      <span title="Impressions"><b>{compact(t.impressions)}</b> impr</span>
      <span title="Clicks"><b>{compact(t.clicks)}</b> clicks</span>
      <span title="Cost"><b>{money(t.cost, currency)}</b></span>
      {t.conversions > 0 ? <span title="Conversions"><b>{nf.format(Math.round(t.conversions))}</b> conv</span> : null}
    </div>
  );
}

function AssetCard({ a, currency }) {
  const kind = assetKind(a);
  const isText = kind === 'headline' || kind === 'description';
  const videoUrl = a.youtubeId ? `https://www.youtube.com/watch?v=${a.youtubeId}` : null;

  return (
    <article className={`ai-card ai-asset ai-asset--${kind}`}>
      {!isText && (
        <div className="ai-asset-media">
          {kind === 'video' && a.thumbnail ? (
            <a href={videoUrl} target="_blank" rel="noopener noreferrer" className="ai-video-link" title="Open on YouTube">
              <img src={a.thumbnail} alt={a.videoTitle || 'Video asset'} loading="lazy" />
              <span className="ai-play" aria-hidden>▶</span>
            </a>
          ) : a.imageUrl ? (
            <a href={a.imageUrl} target="_blank" rel="noopener noreferrer" title="Open full size">
              <img src={a.imageUrl} alt={a.name || 'Image asset'} loading="lazy" />
            </a>
          ) : (
            <div className="ai-media-missing">No preview</div>
          )}
          <LabelBadge label={a.performanceLabel} />
        </div>
      )}
      <div className="ai-asset-body">
        {isText && (
          <div className="ai-asset-text-head">
            <span className="ai-chip">{prettyField(a.fieldType)}</span>
            <LabelBadge label={a.performanceLabel} />
          </div>
        )}
        {isText ? (
          <p className="ai-asset-text">{a.text}</p>
        ) : (
          <div className="ai-asset-title">
            <span className="ai-chip">{prettyField(a.fieldType)}</span>
            {a.width && a.height ? <span className="ai-dim">{a.width}×{a.height}</span> : null}
            {a.videoTitle ? <span className="ai-asset-name" title={a.videoTitle}>{a.videoTitle}</span> : null}
          </div>
        )}
        <Metrics t={a.totals} currency={currency} />
        {a.campaigns?.length ? (
          <div className="ai-asset-camps" title={a.campaigns.join(', ')}>
            {a.campaigns[0]}{a.campaigns.length > 1 ? ` +${a.campaigns.length - 1}` : ''}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function SortableTable({ columns, rows, initialSort, empty }) {
  const [sort, setSort] = useState(initialSort);
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = col.value || ((r) => r[col.key]);
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const cmp = typeof x === 'string' ? x.localeCompare(y) : (x || 0) - (y || 0);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, columns, sort]);

  const toggle = (key) => setSort((s) => (s.key === key
    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'desc' }));

  if (!rows.length) return empty;
  return (
    <div className="ai-table-wrap">
      <table className="ai-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`${c.num ? 'num' : ''} ${sort.key === c.key ? 'is-sorted' : ''}`}
                onClick={() => toggle(c.key)}
                aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                {c.label}{sort.key === c.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 500).map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : r[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > 500 ? <div className="ai-table-note">Showing top 500 of {nf.format(sorted.length)}.</div> : null}
    </div>
  );
}

/* ───────────── page ───────────── */

export default function AdInsights() {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [days, setDays] = useState(30);
  const [appKey, setAppKey] = useState('all');
  const [tab, setTab] = useState('assets');
  const [assetFilter, setAssetFilter] = useState('all');
  const [search, setSearch] = useState('');

  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState(null);
  const [state, setState] = useState({
    loading: false, error: null, currency: 'USD', apps: [], assets: [], keywords: [], searchTerms: [], warnings: [],
  });
  const reqId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await adInsightsAPI.listAccounts();
        if (cancelled) return;
        const list = Array.isArray(data?.accounts) ? data.accounts : [];
        setAccounts(list);
        if (list.length) setAccountId(list[0].id);
      } catch (err) {
        logErrorForDebug(err, 'Ad Insights accounts');
        if (!cancelled) setBootError(getUserFacingMessage(err, 'Could not load your Google Ads accounts.'));
      } finally {
        if (!cancelled) setBootLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    const id = ++reqId.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    const params = { accountId, days };
    try {
      const [apps, assets, kw] = await Promise.all([
        adInsightsAPI.apps(params),
        adInsightsAPI.assets(params),
        adInsightsAPI.keywords(params),
      ]);
      if (id !== reqId.current) return;
      setState({
        loading: false,
        error: null,
        currency: apps?.currency || 'USD',
        apps: apps?.apps || [],
        assets: assets?.assets || [],
        keywords: kw?.keywords || [],
        searchTerms: kw?.searchTerms || [],
        warnings: kw?.warnings || [],
      });
    } catch (err) {
      if (id !== reqId.current) return;
      logErrorForDebug(err, 'Ad Insights load');
      setState((s) => ({ ...s, loading: false, error: getUserFacingMessage(err, 'Could not load data from Google Ads.') }));
    }
  }, [accountId, days]);

  useEffect(() => { setAppKey('all'); load(); }, [load]);

  const { loading, error, currency, apps, assets, keywords, searchTerms, warnings } = state;

  const selectedApp = useMemo(() => apps.find((a) => a.key === appKey) || null, [apps, appKey]);
  const campaignNames = useMemo(
    () => (selectedApp ? new Set(selectedApp.campaigns.map((c) => c.campaignName)) : null),
    [selectedApp],
  );
  const q = search.trim().toLowerCase();

  const scopedAssets = useMemo(() => assets.filter((a) => {
    if (campaignNames && !a.campaigns.some((c) => campaignNames.has(c))) return false;
    if (assetFilter !== 'all' && assetKind(a) !== assetFilter) return false;
    if (q && !`${a.text || ''} ${a.name || ''} ${a.videoTitle || ''}`.toLowerCase().includes(q)) return false;
    return true;
  }), [assets, campaignNames, assetFilter, q]);

  const scopedKeywords = useMemo(() => keywords.filter((k) => (
    (!campaignNames || campaignNames.has(k.campaign)) && (!q || k.keyword.toLowerCase().includes(q))
  )), [keywords, campaignNames, q]);

  const scopedTerms = useMemo(() => searchTerms.filter((t) => (
    (!campaignNames || campaignNames.has(t.campaign)) && (!q || t.term.toLowerCase().includes(q))
  )), [searchTerms, campaignNames, q]);

  const totals = useMemo(() => (selectedApp
    ? selectedApp.totals
    : sumTotals(apps.map((a) => a.totals))), [apps, selectedApp]);

  const assetCounts = useMemo(() => {
    const base = assets.filter((a) => !campaignNames || a.campaigns.some((c) => campaignNames.has(c)));
    const c = { all: base.length, image: 0, video: 0, headline: 0, description: 0 };
    base.forEach((a) => { c[assetKind(a)] += 1; });
    return c;
  }, [assets, campaignNames]);

  /** Fallback "keywords" for app campaigns: the most-used words across headlines and descriptions. */
  const copyThemes = useMemo(() => {
    const freq = new Map();
    assets
      .filter((a) => a.text && (!campaignNames || a.campaigns.some((c) => campaignNames.has(c))))
      .forEach((a) => {
        const weight = Math.max(1, a.totals.impressions);
        String(a.text).toLowerCase().match(/[\p{L}\p{N}']{3,}/gu)?.forEach((w) => {
          if (STOP_WORDS.has(w)) return;
          freq.set(w, (freq.get(w) || 0) + weight);
        });
      });
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  }, [assets, campaignNames]);

  const exportCsv = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let head;
    let body;
    if (tab === 'assets') {
      head = ['Type', 'Field', 'Text / name', 'Label', 'Impressions', 'Clicks', 'Cost', 'Conversions', 'Campaigns', 'URL'];
      body = scopedAssets.map((a) => [assetKind(a), a.fieldType, a.text || a.videoTitle || a.name, a.performanceLabel,
        a.totals.impressions, a.totals.clicks, a.totals.cost.toFixed(2), a.totals.conversions,
        a.campaigns.join(' | '), a.imageUrl || (a.youtubeId ? `https://www.youtube.com/watch?v=${a.youtubeId}` : '')]);
    } else if (tab === 'keywords') {
      head = ['Keyword', 'Match', 'Campaign', 'Ad group', 'Quality score', 'Impressions', 'Clicks', 'Cost', 'Conversions'];
      body = scopedKeywords.map((k) => [k.keyword, k.matchType, k.campaign, k.adGroup, k.qualityScore ?? '',
        k.totals.impressions, k.totals.clicks, k.totals.cost.toFixed(2), k.totals.conversions]);
    } else {
      head = ['Search term', 'Campaign', 'Impressions', 'Clicks', 'Cost', 'Conversions'];
      body = scopedTerms.map((t) => [t.term, t.campaign, t.totals.impressions, t.totals.clicks,
        t.totals.cost.toFixed(2), t.totals.conversions]);
    }
    const csv = [head, ...body].map((r) => r.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `ad-insights-${tab}-${days}d.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  /* ── early states ── */
  if (bootLoading) {
    return (
      <div className="ai-page">
        <PageHeader title="Ad Insights" subtitle="Loading your Google Ads accounts…" />
        <Skeleton rows={3} />
      </div>
    );
  }
  if (bootError) {
    return (
      <div className="ai-page">
        <PageHeader title="Ad Insights" />
        <EmptyState title="Couldn’t load accounts">{bootError}</EmptyState>
      </div>
    );
  }
  if (!accounts.length) {
    return (
      <div className="ai-page">
        <PageHeader title="Ad Insights" subtitle="See the assets and keywords behind your apps’ ads." />
        <EmptyState title="No Google Ads account connected">
          Connect an account from the <a href="/my-ads">Google Ads</a> page (or ask an admin to grant you one), then come back here.
        </EmptyState>
      </div>
    );
  }

  const currentAccount = accounts.find((a) => a.id === accountId);

  return (
    <div className="ai-page">
      <PageHeader
        title="Ad Insights"
        subtitle="The creative assets, keywords and search terms behind your apps’ Google Ads campaigns."
      >
        <Button variant="secondary" onClick={load} loading={loading}>Refresh</Button>
        <Button variant="secondary" onClick={exportCsv} disabled={loading || !!error}>Export CSV</Button>
      </PageHeader>

      {/* toolbar */}
      <div className="ai-toolbar">
        <label className="ai-field">
          <span>Account</span>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}{a.customerId ? ` · ${a.customerId}` : ''}</option>
            ))}
          </select>
        </label>
        <div className="ai-field">
          <span>Period</span>
          <div className="ai-seg" role="group" aria-label="Date range">
            {RANGES.map((r) => (
              <button
                key={r.days}
                type="button"
                className={days === r.days ? 'is-active' : ''}
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <label className="ai-field ai-field--grow">
          <span>Search</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tab === 'assets' ? 'Search headlines, descriptions, videos…' : 'Search keywords…'}
          />
        </label>
      </div>

      {error ? (
        <EmptyState title="Google Ads returned an error">
          {error}
          <div><Button variant="secondary" onClick={load}>Try again</Button></div>
        </EmptyState>
      ) : (
        <>
          {/* KPIs */}
          <section className="ai-kpis" aria-busy={loading}>
            <Kpi label="Spend" value={loading ? '—' : money(totals.cost, currency)} hint={`Last ${days} days`} />
            <Kpi label="Impressions" value={loading ? '—' : compact(totals.impressions)} />
            <Kpi label="Clicks" value={loading ? '—' : compact(totals.clicks)} />
            <Kpi label="CTR" value={loading ? '—' : pct(totals.ctr)} />
            <Kpi label="Conversions" value={loading ? '—' : nf.format(Math.round(totals.conversions))} />
            <Kpi label="Cost / conv." value={loading ? '—' : (totals.conversions ? money(totals.cpa, currency) : '—')} />
          </section>

          {/* apps */}
          <section className="ai-section">
            <h3 className="ai-section-title">
              Apps &amp; campaigns <span className="ai-count">{apps.length}</span>
            </h3>
            {loading && !apps.length ? <Skeleton rows={3} /> : (
              <div className="ai-apps" role="listbox" aria-label="Apps">
                <button
                  type="button"
                  role="option"
                  aria-selected={appKey === 'all'}
                  className={`ai-app ${appKey === 'all' ? 'is-active' : ''}`}
                  onClick={() => setAppKey('all')}
                >
                  <div className="ai-app-name">All apps</div>
                  <div className="ai-app-sub">{currentAccount?.name}</div>
                  <div className="ai-app-spend">{money(sumTotals(apps.map((a) => a.totals)).cost, currency)}</div>
                </button>
                {apps.map((a) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={appKey === a.key}
                    key={a.key}
                    className={`ai-app ${appKey === a.key ? 'is-active' : ''}`}
                    onClick={() => setAppKey(a.key)}
                    title={a.appId || a.name}
                  >
                    <div className="ai-app-name">{a.appId || a.name}</div>
                    <div className="ai-app-sub">
                      {storeLabel(a.store) ? <span className="ai-chip">{storeLabel(a.store)}</span> : null}
                      {a.campaigns.length} campaign{a.campaigns.length === 1 ? '' : 's'}
                    </div>
                    <div className="ai-app-spend">{money(a.totals.cost, currency)}</div>
                  </button>
                ))}
                {!apps.length && !loading ? (
                  <EmptyState title="No campaigns with activity">
                    This account had no campaigns with data in the last {days} days.
                  </EmptyState>
                ) : null}
              </div>
            )}
          </section>

          {/* tabs */}
          <section className="ai-section">
            <div className="ai-tabs" role="tablist">
              {TABS.map((t) => {
                const count = t.id === 'assets' ? assetCounts.all : t.id === 'keywords' ? scopedKeywords.length : scopedTerms.length;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    className={tab === t.id ? 'is-active' : ''}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}<span className="ai-count">{loading ? '…' : nf.format(count)}</span>
                  </button>
                );
              })}
            </div>

            {warnings.length ? (
              <div className="ai-note" role="status">Some keyword data couldn’t be loaded: {warnings.join('; ')}</div>
            ) : null}

            {tab === 'assets' && (
              <>
                <div className="ai-filters">
                  {ASSET_FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`ai-pill ${assetFilter === f.id ? 'is-active' : ''}`}
                      onClick={() => setAssetFilter(f.id)}
                    >
                      {f.label} <span>{assetCounts[f.id]}</span>
                    </button>
                  ))}
                </div>
                {loading ? <Skeleton /> : scopedAssets.length ? (
                  <div className="ai-grid">
                    {scopedAssets.slice(0, 300).map((a) => <AssetCard key={`${a.id}-${a.fieldType}`} a={a} currency={currency} />)}
                  </div>
                ) : (
                  <EmptyState title="No assets found">
                    Asset reporting is available for App campaigns and responsive ads. Try a longer period or another app.
                  </EmptyState>
                )}
              </>
            )}

            {tab === 'keywords' && (loading ? <Skeleton rows={3} /> : (
              <>
                <SortableTable
                  initialSort={{ key: 'clicks', dir: 'desc' }}
                  rows={scopedKeywords}
                  empty={(
                    <EmptyState title="No keywords for this selection">
                      App campaigns don’t use keywords — Google chooses where they show. Below are the most
                      prominent themes from your ad copy instead.
                    </EmptyState>
                  )}
                  columns={[
                    { key: 'keyword', label: 'Keyword', render: (r) => <b>{r.keyword}</b> },
                    { key: 'matchType', label: 'Match', render: (r) => <span className="ai-chip">{String(r.matchType || '').toLowerCase()}</span> },
                    { key: 'campaign', label: 'Campaign' },
                    { key: 'qualityScore', label: 'QS', num: true, value: (r) => r.qualityScore || 0, render: (r) => r.qualityScore ?? '—' },
                    { key: 'impressions', label: 'Impr.', num: true, value: (r) => r.totals.impressions, render: (r) => nf.format(r.totals.impressions) },
                    { key: 'clicks', label: 'Clicks', num: true, value: (r) => r.totals.clicks, render: (r) => nf.format(r.totals.clicks) },
                    { key: 'ctr', label: 'CTR', num: true, value: (r) => r.totals.ctr, render: (r) => pct(r.totals.ctr) },
                    { key: 'cost', label: 'Cost', num: true, value: (r) => r.totals.cost, render: (r) => money(r.totals.cost, currency) },
                    { key: 'cpc', label: 'CPC', num: true, value: (r) => r.totals.cpc, render: (r) => money(r.totals.cpc, currency) },
                    { key: 'conv', label: 'Conv.', num: true, value: (r) => r.totals.conversions, render: (r) => nf.format(Math.round(r.totals.conversions)) },
                  ]}
                />
                {!scopedKeywords.length && copyThemes.length ? (
                  <div className="ai-themes">
                    <h4>Themes in your ad copy</h4>
                    <div className="ai-cloud">
                      {copyThemes.map(([word], i) => (
                        <button
                          type="button"
                          key={word}
                          className="ai-theme"
                          style={{ fontSize: `${Math.max(12, 20 - i * 0.35)}px` }}
                          onClick={() => { setSearch(word); setTab('assets'); }}
                          title="Show assets using this word"
                        >
                          {word}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ))}

            {tab === 'terms' && (loading ? <Skeleton rows={3} /> : (
              <SortableTable
                initialSort={{ key: 'clicks', dir: 'desc' }}
                rows={scopedTerms}
                empty={<EmptyState title="No search terms for this selection">Google only reports search terms for campaigns that run on Search.</EmptyState>}
                columns={[
                  { key: 'term', label: 'Search term', render: (r) => <b>{r.term}</b> },
                  { key: 'campaign', label: 'Campaign' },
                  { key: 'impressions', label: 'Impr.', num: true, value: (r) => r.totals.impressions, render: (r) => nf.format(r.totals.impressions) },
                  { key: 'clicks', label: 'Clicks', num: true, value: (r) => r.totals.clicks, render: (r) => nf.format(r.totals.clicks) },
                  { key: 'ctr', label: 'CTR', num: true, value: (r) => r.totals.ctr, render: (r) => pct(r.totals.ctr) },
                  { key: 'cost', label: 'Cost', num: true, value: (r) => r.totals.cost, render: (r) => money(r.totals.cost, currency) },
                  { key: 'conv', label: 'Conv.', num: true, value: (r) => r.totals.conversions, render: (r) => nf.format(Math.round(r.totals.conversions)) },
                ]}
              />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
