import React, { useCallback, useEffect, useMemo, useState } from 'react';
import GamOverviewCard from '../ui/GamOverviewCard';
import { reportsAPI } from '../../utils/api';
import { getUserFacingMessage } from '../../utils/userFacingError';

function withDailyEcpm(series = []) {
  return (Array.isArray(series) ? series : []).map((d) => {
    const impressions = Number(d.impressions) || 0;
    const revenue = Number(d.revenue) || 0;
    const ecpm = impressions > 0 ? (revenue / impressions) * 1000 : (Number(d.ecpm) || 0);
    return { ...d, ecpm };
  });
}

/**
 * Overview KPIs for one GAM network (scoped via X-Gam-Client-Id).
 */
export default function NetworkDashboardSection({
  network,
  filters = {},
}) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const clientId = network?.id;
  const filtersKey = useMemo(
    () => JSON.stringify({ clientId, filters }),
    [clientId, filters]
  );

  const load = useCallback(async () => {
    if (!clientId) return;
    setError(null);
    setLoading(true);
    try {
      const ov = await reportsAPI.getDashboardOverview(filters, { clientId });
      setOverview(ov);
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not load this network.'));
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [clientId, filters]);

  useEffect(() => {
    load();
  }, [filtersKey, load]);

  const currency = overview?.summary?.currency || 'USD';
  const overviewSummary = useMemo(() => {
    const s = overview?.summary || {};
    return {
      impressions: s.impressions ?? 0,
      revenue: s.revenue ?? s.selectRange ?? 0,
      ecpm: s.ecpm ?? 0,
      viewability: s.viewability ?? 0,
      impressionsChange: s.impressionsChange,
      revenueChange: s.revenueChange ?? s.selectRangeChange,
      ecpmChange: s.ecpmChange,
      viewabilityChange: s.viewabilityChange,
    };
  }, [overview]);

  const clientMismatch = overview?._client?.id
    && clientId
    && String(overview._client.id) !== String(clientId);

  const sparkSeries = useMemo(
    () => withDailyEcpm(overview?.daily || overview?.trend || []),
    [overview]
  );

  const title = network?.name || network?.networkCode || 'Network';
  const code = network?.networkCode;

  return (
    <section className="multi-network-section" aria-label={title}>
      <header className="multi-network-section-head">
        <div>
          <h2 className="multi-network-section-title">{title}</h2>
          {code ? (
            <p className="multi-network-section-sub">Network {code}</p>
          ) : null}
        </div>
        <button type="button" className="btn-reset" onClick={load} disabled={loading}>
          Refresh
        </button>
      </header>

      {error && (
        <div className="error-box dash-error-box" role="alert">
          <div className="dash-error-copy">
            <strong>Couldn&apos;t load {title}</strong>
            <span>{error}</span>
          </div>
          <button type="button" onClick={load} className="btn-retry">Retry</button>
        </div>
      )}

      {clientMismatch && (
        <div className="error-box dash-error-box" role="alert">
          <div className="dash-error-copy">
            <strong>Wrong network data</strong>
            <span>
              Expected {code || clientId?.slice?.(0, 8)}, got{' '}
              {overview._client?.networkCode || overview._client?.name || overview._client?.id?.slice?.(0, 8)}.
              Retry or restart the backend.
            </span>
          </div>
          <button type="button" onClick={load} className="btn-retry">Retry</button>
        </div>
      )}

      <div className="dash-overview-row">
        <GamOverviewCard
          summary={clientMismatch ? {} : overviewSummary}
          currency={currency}
          loading={loading && !overview}
          sparkSeries={clientMismatch ? [] : sparkSeries}
        />
      </div>
    </section>
  );
}
