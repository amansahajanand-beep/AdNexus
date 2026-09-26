import React, { useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
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
import { ADMOB_SAMPLE } from '../../utils/productSampleData';
import { admobAPI } from '../../utils/api';
import { CHART_SERIES } from '../../utils/chartTheme';
import { copyReportLink } from '../../utils/report/reportShare';
import { SAVED_FILTERS_PAGES } from '../../utils/savedFilters';
import { PRESET_PAGES } from '../../utils/reportPresets';
import { showToast } from '../../hooks/useToast';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../store/useAuth';
import usePublisherReport from '../../hooks/usePublisherReport';

const ACCENT = '#0D9488';

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

export default function AdMobDashboard() {
  const { user, isAdmin } = useAuth();
  const { visibility } = usePermissions();
  const { viewAdmobAccountId } = useOutletContext() || {};
  const compare = useProductCompareState(user?.id);
  const report = usePublisherReport(admobAPI, {
    product: 'admob',
    canUseFilters: visibility.filters !== false,
    defaultBreakdownDim: 'app',
    defaultTableDim: 'app',
    compareMode: compare.compareMode,
    compareStart: compare.compareStart,
    compareEnd: compare.compareEnd,
    includeExtraFilters: false,
    accountId: isAdmin ? (viewAdmobAccountId || null) : null,
  });

  const useSample = report.isSample;
  const live = report.overview;
  const currency = live?.currency || 'USD';
  const accountLabel = useSample
    ? ADMOB_SAMPLE.accountLabel
    : (live?.account?.descriptiveName || live?.account?.accountId || 'AdMob account');

  const kpis = useSample ? ADMOB_SAMPLE.kpis : (live?.kpis || []);
  const trend = useMemo(() => {
    if (useSample) return ADMOB_SAMPLE.trend;
    return (live?.trend || []).map((r) => ({
      date: formatTrendDate(r.date),
      earnings: Number(r.earnings) || 0,
      impressions: Number(r.impressions) || 0,
    }));
  }, [live, useSample]);

  const byApp = useSample ? ADMOB_SAMPLE.topApps : (report.breakdown.rows || []).map((r) => ({
    name: r.name,
    earnings: Number(r.earnings) || 0,
  }));
  const byFormat = useSample ? ADMOB_SAMPLE.byFormat : (report.secondaryBreakdown.rows || []).map((r) => ({
    name: r.name,
    earnings: Number(r.earnings) || 0,
  }));
  const tableDim = report.table.dim || 'app';
  const tableTitle = {
    app: 'Apps',
    ad_unit: 'Ad units',
    format: 'Formats',
    country: 'Countries',
    platform: 'Platforms',
    ad_source: 'Ad sources',
    ad_source_instance: 'Ad source instances',
    mediation_group: 'Mediation groups',
    date: 'Days',
  }[tableDim] || 'Inventory';
  const tableRows = useSample
    ? ADMOB_SAMPLE.tableRows.map((r) => ({
      name: `${r.app} · ${r.adUnit}`,
      impressions: r.impressions,
      clicks: r.clicks,
      earnings: r.earnings,
      ecpm: r.ecpm,
      ctr: r.ctr,
    }))
    : (report.table.rows?.length
      ? report.table.rows
      : (report.breakdown.rows || []).map((r) => ({
        name: r.name,
        impressions: r.impressions,
        clicks: r.clicks,
        earnings: r.earnings,
        ecpm: r.ecpm,
        ctr: r.ctr,
      })));
  const lastSyncAt = report.freshness?.lastSyncAt || live?.lastSyncAt;
  const canFilter = visibility.filters !== false;

  const handleCopyLink = async () => {
    await copyReportLink(report.getSharePayload());
    showToast({ message: 'Link copied — opens this exact report' });
  };

  return (
    <div className="dashboard-page page product-page product-page--admob">
      <PageHeader
        title="AdMob Dashboard"
        subtitle={useSample
          ? 'Mobile app mediation — sample data until an AdMob account is connected and synced'
          : 'Mobile app mediation overview — charts load for the selected dates; inventory filters refine them'}
        summary={report.filterSummary}
      >
        {canFilter && (
          <>
            <button type="button" className="btn-reset btn-copy-link" onClick={handleCopyLink}>
              Copy link
            </button>
            <SavePresetButton
              page={PRESET_PAGES.admob}
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
      <DataFreshness lastSyncAt={lastSyncAt} productLabel="AdMob" className="dash-freshness" />

      {report.error ? <p className="form-error" role="alert">{report.error}</p> : null}

      <p className="product-account-chip" title="Active AdMob account">{accountLabel}</p>

      <ProductReportFilters
        product="admob"
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
        savedPage={SAVED_FILTERS_PAGES.admob}
        presetPage={PRESET_PAGES.admob}
        getSavedFilterSnapshot={report.getSavedFilterSnapshot}
        getPresetSnapshot={report.getPresetSnapshot}
        getSharePayload={report.getSharePayload}
        onApplySavedFilter={report.applySavedSnapshot}
        onApplyRecentFilter={report.applyRecentSnapshot}
        timeZone={report.reportingTimeZone}
        enableExtraFilters={false}
      />

      <ProductKpiStrip
        kpis={kpis}
        currency={currency}
        accentColor={ACCENT}
        compareLabel={report.compareLabel}
      />

      <section className="chart-card product-chart-wide">
        <div className="chart-card-head">
          <h3 className="chart-card-title">Earnings &amp; impressions by day</h3>
        </div>
        <div className="chart-card-body" style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trend} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="admobEarn" x1="0" y1="0" x2="0" y2="1">
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
                <Area yAxisId="left" type="monotone" dataKey="earnings" name="Earnings" stroke={ACCENT} fill="url(#admobEarn)" strokeWidth={2} />
              ) : null}
              {report.visibility.impressions !== false ? (
                <Area yAxisId="right" type="monotone" dataKey="impressions" name="Impressions" stroke={CHART_SERIES.secondary || '#64748B'} fill="transparent" strokeWidth={2} />
              ) : null}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="product-chart-grid">
        <section className="chart-card">
          <div className="chart-card-head">
            <h3 className="chart-card-title">Top apps by earnings</h3>
          </div>
          <div className="chart-card-body" style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byApp} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => money(v)} />
                <Bar dataKey="earnings" name="Earnings" fill={ACCENT} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="chart-card">
          <div className="chart-card-head">
            <h3 className="chart-card-title">
              {report.secondaryBreakdown.dim === 'country' ? 'Earnings by country' : 'Earnings by ad format'}
            </h3>
          </div>
          <div className="chart-card-body" style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byFormat} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => money(v)} />
                <Bar dataKey="earnings" name="Earnings" fill={ACCENT} radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <ProductDetailTable
        title={useSample ? 'Ad units (sample)' : tableTitle}
        product="admob"
        dim={useSample ? 'ad_unit' : tableDim}
        currency={currency}
        visibility={report.visibility}
        loading={report.loading}
        rows={tableRows || []}
        emptyMessage="No inventory rows for this range — try last 7 days or Sync now in Admin."
      />
    </div>
  );
}
