import React, { useEffect, useMemo, useState } from 'react';
import { roiAPI } from '../../utils/api';
import { mergePresetWithDates } from '../../utils/reportPresets';
import {
  formatRoiMoney,
  formatRoiMoneyCompact,
  formatRoiPct,
  roiToneClass,
  snapshotToRoiSummaryParams,
} from '../../utils/report/roiView';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';

function deltaTone(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  const v = Number(n);
  if (v > 0) return 'pos';
  if (v < 0) return 'neg';
  return null;
}

function formatDeltaMoney(n, currency) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${formatRoiMoneyCompact(v, currency)}`;
}

function formatDeltaPct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)} pp`;
}

/**
 * Side-by-side ROI KPI compare for two presets (same date range).
 */
export default function RoiPresetCompare({
  presetA,
  presetB,
  startDate,
  endDate,
  datePreset,
}) {
  const snapA = useMemo(
    () => mergePresetWithDates(presetA?.snapshot || {}, { startDate, endDate, preset: datePreset }),
    [presetA?.snapshot, startDate, endDate, datePreset]
  );
  const snapB = useMemo(
    () => mergePresetWithDates(presetB?.snapshot || {}, { startDate, endDate, preset: datePreset }),
    [presetB?.snapshot, startDate, endDate, datePreset]
  );

  const [summaryA, setSummaryA] = useState(null);
  const [summaryB, setSummaryB] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!presetA?.id || !presetB?.id) {
      setSummaryA(null);
      setSummaryB(null);
      setError(null);
      return undefined;
    }
    const paramsA = snapshotToRoiSummaryParams(snapA);
    const paramsB = snapshotToRoiSummaryParams(snapB);
    if (!paramsA || !paramsB) {
      setSummaryA(null);
      setSummaryB(null);
      setError('Select a date range and click Apply dates.');
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [resA, resB] = await Promise.all([
          roiAPI.summary({ ...paramsA, summaryOnly: '1' }),
          roiAPI.summary({ ...paramsB, summaryOnly: '1' }),
        ]);
        if (cancelled) return;
        setSummaryA(resA?.summary || null);
        setSummaryB(resB?.summary || null);
      } catch (err) {
        if (cancelled) return;
        logErrorForDebug(err, 'ROI preset compare');
        setError(getUserFacingMessage(err, 'Could not compare these presets.'));
        setSummaryA(null);
        setSummaryB(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [
    presetA?.id,
    presetB?.id,
    snapA.startDate,
    snapA.endDate,
    JSON.stringify(snapA.accountIds || []),
    JSON.stringify(snapA.campaignIds || []),
    JSON.stringify(snapA.appKeys || []),
    JSON.stringify(snapA.siteKeys || []),
    JSON.stringify(snapA.countryCodes || []),
    snapB.startDate,
    snapB.endDate,
    JSON.stringify(snapB.accountIds || []),
    JSON.stringify(snapB.campaignIds || []),
    JSON.stringify(snapB.appKeys || []),
    JSON.stringify(snapB.siteKeys || []),
    JSON.stringify(snapB.countryCodes || []),
  ]);

  const currency = summaryA?.adsSpendCurrency
    || summaryB?.adsSpendCurrency
    || summaryA?.spendCurrency
    || summaryB?.spendCurrency
    || 'USD';

  const rows = useMemo(() => {
    const a = summaryA || {};
    const b = summaryB || {};
    const spendA = Number(a.adsSpend) || 0;
    const spendB = Number(b.adsSpend) || 0;
    const earnA = Number(a.earn) || 0;
    const earnB = Number(b.earn) || 0;
    const profitA = Number(a.profitSpend);
    const profitB = Number(b.profitSpend);
    const profitAVal = Number.isFinite(profitA) ? profitA : earnA - spendA;
    const profitBVal = Number.isFinite(profitB) ? profitB : earnB - spendB;
    const roiA = a.roiSpendPercent == null ? null : Number(a.roiSpendPercent);
    const roiB = b.roiSpendPercent == null ? null : Number(b.roiSpendPercent);

    return [
      {
        key: 'spend',
        label: 'Spend',
        a: formatRoiMoneyCompact(spendA, currency),
        aTitle: formatRoiMoney(spendA, currency),
        b: formatRoiMoneyCompact(spendB, currency),
        bTitle: formatRoiMoney(spendB, currency),
        delta: formatDeltaMoney(spendB - spendA, currency),
        deltaTone: deltaTone(spendB - spendA),
      },
      {
        key: 'earn',
        label: 'Earn',
        a: formatRoiMoneyCompact(earnA, currency),
        aTitle: formatRoiMoney(earnA, currency),
        b: formatRoiMoneyCompact(earnB, currency),
        bTitle: formatRoiMoney(earnB, currency),
        delta: formatDeltaMoney(earnB - earnA, currency),
        deltaTone: deltaTone(earnB - earnA),
      },
      {
        key: 'profit',
        label: 'Profit',
        a: formatRoiMoneyCompact(profitAVal, currency),
        aTitle: formatRoiMoney(profitAVal, currency),
        aTone: roiToneClass(profitAVal),
        b: formatRoiMoneyCompact(profitBVal, currency),
        bTitle: formatRoiMoney(profitBVal, currency),
        bTone: roiToneClass(profitBVal),
        delta: formatDeltaMoney(profitBVal - profitAVal, currency),
        deltaTone: deltaTone(profitBVal - profitAVal),
      },
      {
        key: 'roi',
        label: 'ROI',
        a: formatRoiPct(roiA),
        aTone: roiToneClass(roiA),
        b: formatRoiPct(roiB),
        bTone: roiToneClass(roiB),
        delta: (roiA == null || roiB == null) ? '—' : formatDeltaPct(roiB - roiA),
        deltaTone: (roiA == null || roiB == null) ? null : deltaTone(roiB - roiA),
      },
    ];
  }, [summaryA, summaryB, currency]);

  if (!presetB) {
    return (
      <div className="presets-compare-banner" role="status">
        <strong>Compare mode</strong>
        <span> — select another ROI preset in the list as B.</span>
      </div>
    );
  }

  return (
    <div className="presets-compare">
      <div className="presets-compare-head">
        <div className="presets-compare-col-label">
          <span className="presets-compare-badge">A</span>
          <span className="presets-compare-name" title={presetA?.name}>{presetA?.name}</span>
        </div>
        <div className="presets-compare-col-label presets-compare-delta-label">Δ (B − A)</div>
        <div className="presets-compare-col-label">
          <span className="presets-compare-badge is-b">B</span>
          <span className="presets-compare-name" title={presetB?.name}>{presetB?.name}</span>
        </div>
      </div>

      {error ? <div className="login-error" style={{ marginTop: 8 }}>{error}</div> : null}

      <div className={`presets-compare-grid${loading ? ' is-loading' : ''}`}>
        {rows.map((row) => (
          <div key={row.key} className="presets-compare-row">
            <div className="presets-compare-metric">
              <span className="presets-compare-metric-label">{row.label}</span>
              <span
                className={`presets-compare-metric-value${row.aTone ? ` tone-${row.aTone}` : ''}`}
                title={row.aTitle}
              >
                {loading && !summaryA ? '…' : row.a}
              </span>
            </div>
            <div className={`presets-compare-delta${row.deltaTone ? ` tone-${row.deltaTone}` : ''}`}>
              {loading && (!summaryA || !summaryB) ? '…' : row.delta}
            </div>
            <div className="presets-compare-metric">
              <span className="presets-compare-metric-label">{row.label}</span>
              <span
                className={`presets-compare-metric-value${row.bTone ? ` tone-${row.bTone}` : ''}`}
                title={row.bTitle}
              >
                {loading && !summaryB ? '…' : row.b}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
