import React, { useMemo } from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import PageHeader from '../../components/ui/PageHeader';
import DataFreshness from '../../components/ui/DataFreshness';
import SavePresetButton from '../../components/ui/SavePresetButton';
import ProductKpiStrip from '../../components/ui/ProductKpiStrip';
import ProductReportFilters, { useProductCompareState } from '../../components/ui/ProductReportFilters';
import ProductDetailTable from '../../components/ui/ProductDetailTable';
import { ADSENSE_SAMPLE } from '../../utils/productSampleData';
import { adsenseAPI } from '../../utils/api';
import { CHART_SERIES } from '../../utils/chartTheme';
import { copyReportLink } from '../../utils/report/reportShare';
import { SAVED_FILTERS_PAGES } from '../../utils/savedFilters';
import { PRESET_PAGES } from '../../utils/reportPresets';
import { showToast } from '../../hooks/useToast';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../store/useAuth';
import usePublisherReport from '../../hooks/usePublisherReport';

const ACCENT = '#D97706';

function money(n) {
  return `US$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTrendDate(ymd) {
  if (!ymd) return '';
  try {
    const d = new Date(`${ymd}T00:00:00`);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return ymd;
  }
}

export default function AdSenseDashboard() {
  const { user } = useAuth();
  const { visibility } = usePermissions();
  const compare = useProductCompareState(user?.id);
  const report = usePublisherReport(adsenseAPI, {
    product: 'adsense',
    canUseFilters: visibility.filters !== false,
    defaultBreakdownDim: 'site',
    defaultTableDim: 'ad_unit',
    compareMode: compare.compareMode,
    compareStart: compare.compareStart,
    compareEnd: compare.compareEnd,
  });

  const useSample = report.isSample;
  const live = report.overview;
  const currency = live?.currency || 'USD';
  const accountLabel = useSample
    ? ADSENSE_SAMPLE.accountLabel
    : (live?.account?.descriptiveName || live?.account?.accountId || 'AdSense account');

  const kpis = useSample ? ADSENSE_SAMPLE.kpis : (live?.kpis || []);
  const trend = useMemo(() => {
    if (useSample) return ADSENSE_SAMPLE.trend;
    return (live?.trend || []).map((r) => ({
      date: formatTrendDate(r.date),
      earnings: Number(r.earnings) || 0,
      pageViews: Number(r.page_views) || 0,
    }));
  }, [live, useSample]);

  const topSites = useSample ? ADSENSE_SAMPLE.topSites : (report.breakdown.rows || []).map((r) => ({
    name: r.name,
    earnings: Number(r.earnings) || 0,
  }));
  const byCountry = useSample ? ADSENSE_SAMPLE.byCountry : (report.secondaryBreakdown.rows || []).map((r) => ({
    name: r.name,
    earnings: Number(r.earnings) || 0,
  }));
  const lastSyncAt = report.freshness?.lastSyncAt || live?.lastSyncAt;
  const canFilter = visibility.filters !== false;

  const handleCopyLink = async () => {
    await copyReportLink(report.getSharePayload());
    showToast({ message: 'Link copied — opens this exact report' });
  };

  return (
    <div className="dashboard-page page product-page product-page--adsense">
      <PageHeader
        title="AdSense Dashboard"
        subtitle={useSample
          ? 'Web & content monetization — sample data until an AdSense account is connected and synced'
          : 'Web & content monetization overview — charts load for the selected dates; inventory filters refine them'}
        summary={report.filterSummary}
      >
        {canFilter && (
          <>
            <button type="button" className="btn-reset btn-copy-link" onClick={handleCopyLink}>
              Copy link
            </button>
            <SavePresetButton
              page={PRESET_PAGES.adsense}
              userId={user?.id}
              getSnapshot={report.getPresetSnapshot}
              disabled={!canFilter}
            />
          </>
        )}
        {useSample ? <span className="product-sample-badge">Sample data</span> : null}
        {report.loading ? (
          <span className="product-sample-badge" style={{ color: 'var(--muted)', background: 'var(--bg-soft)', borderColor: 'var(--border)' }}>
            Loading…
          </span>
        ) : null}
      </PageHeader>
      <DataFreshness lastSyncAt={lastSyncAt} productLabel="AdSense" className="dash-freshness" />

      {report.error ? <p className="form-error" role="alert">{report.error}</p> : null}

      <p className="product-account-chip" title="Active AdSense account">{accountLabel}</p>

      <ProductReportFilters
        product="adsense"
        range={report.range}
        onRangeChange={report.setRange}
        datePreset={report.datePreset}
        onDatePresetChange={report.setDatePreset}
        filters={report.filters}
        filterOptions={report.filterOptions}
        onFilterChange={report.setFilter}
        onFiltersApply={report.applyDimensionFilters}
        onClear={report.clearFilters}
        canUseFilters={canFilter}
        disabled={report.loading}
        compareMode={compare.compareMode}
        onCompareModeChange={compare.setCompareMode}
        compareStart={compare.compareStart}
        compareEnd={compare.compareEnd}
        onCompareStart={compare.setCompareStart}
        onCompareEnd={compare.setCompareEnd}
        userId={user?.id}
        savedPage={SAVED_FILTERS_PAGES.adsense}
        presetPage={PRESET_PAGES.adsense}
        getSavedFilterSnapshot={report.getSavedFilterSnapshot}
        getPresetSnapshot={report.getPresetSnapshot}
        getSharePayload={report.getSharePayload}
        onApplySavedFilter={report.applySavedSnapshot}
        onApplyRecentFilter={report.applyRecentSnapshot}
      />

      <ProductKpiStrip
        kpis={kpis}
        currency={currency}
        accentColor={ACCENT}
        compareLabel={report.compareLabel}
      />

      <section className="chart-card product-chart-wide">
        <div className="chart-card-head">
          <h3 className="chart-card-title">Earnings vs page views</h3>
        </div>
        <div className="chart-card-body" style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trend} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="adsenseEarn" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={ACCENT} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={ACCENT} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              {report.visibility.revenue !== false ? (
                <Area yAxisId="left" type="monotone" dataKey="earnings" name="Earnings" stroke={ACCENT} fill="url(#adsenseEarn)" strokeWidth={2} />
              ) : null}
              <Area yAxisId="right" type="monotone" dataKey="pageViews" name="Page views" stroke={CHART_SERIES.secondary || '#64748B'} fill="transparent" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="product-chart-grid">
        <section className="chart-card">
          <div className="chart-card-head">
            <h3 className="chart-card-title">Top sites by earnings</h3>
          </div>
          <div className="chart-card-body" style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topSites} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-12} textAnchor="end" height={56} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => money(v)} />
                <Bar dataKey="earnings" name="Earnings" fill={ACCENT} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="chart-card">
          <div className="chart-card-head">
            <h3 className="chart-card-title">Earnings by country</h3>
          </div>
          <div className="chart-card-body" style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byCountry} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => money(v)} />
                <Bar dataKey="earnings" name="Earnings" fill={ACCENT} radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      {useSample ? (
        <ProductDetailTable
          title="Ad units (sample)"
          product="adsense"
          dim="ad_unit"
          currency={currency}
          visibility={report.visibility}
          rows={ADSENSE_SAMPLE.tableRows.map((r) => ({
            name: `${r.site} · ${r.adUnit}`,
            impressions: r.impressions,
            page_views: r.pageViews,
            clicks: r.clicks,
            earnings: r.earnings,
            rpm: r.rpm,
            ctr: r.ctr,
          }))}
        />
      ) : (
        <ProductDetailTable
          title="Ad units"
          product="adsense"
          dim={report.table.dim || 'ad_unit'}
          currency={currency}
          visibility={report.visibility}
          loading={report.loading}
          rows={report.table.rows || []}
          emptyMessage="No ad-unit breakdown yet — sync will populate dims."
        />
      )}
    </div>
  );
}
