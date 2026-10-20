import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';
import PresetDateToolbar from '../components/presets/PresetDateToolbar';
import RoiSummaryBoards from '../components/roi/RoiSummaryBoards';
import RoiInventoryEarnOverview from '../components/roi/RoiInventoryEarnOverview';
import RoiCurrencySelect from '../components/roi/RoiCurrencySelect';
import { useRoiDisplayCurrency } from '../utils/report/roiCurrency';
import RoiDateTable from '../components/roi/RoiDateTable';
import { useAuth } from '../store/useAuth';
import { usePresetDateRange } from '../hooks/usePresetDateRange';
import { adsAPI, roiAPI } from '../utils/api';
import { mergePresetWithDates } from '../utils/reportPresets';
import {
  mergeRoiBreakdownPayload,
  mergeRoiSummaryPayload,
  snapshotToRoiSummaryParams,
  sumInventoryEarnFromBreakdown,
} from '../utils/report/roiView';
import { removeRoiSheet, sheetAccountId, sheetName, useRoiSheets } from '../utils/report/roiSheets';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import { confirmDialog } from '../hooks/useConfirmDialog';

/**
 * One Ads account's ROI as a sheet: cards, then a table by day / week / month / year for the chosen dates.
 * Reached from the sidebar (ROI > account name); an admin adds a sheet from the ROI page with one account selected.
 */
export default function RoiSheet() {
  const { sheetId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  useRoiDisplayCurrency();
  const outlet = useOutletContext() || {};
  // Domain user with several networks: an app's Firebase link can sit in any of them.
  const networkIds = user?.role === 'admin' ? [] : (Array.isArray(outlet.mergeNetworkIds) ? outlet.mergeNetworkIds : []).filter(Boolean);
  const netKey = networkIds.join(',');
  const sheets = useRoiSheets(user?.id);
  const sheet = useMemo(() => sheets.find((s) => s.id === sheetId) || null, [sheets, sheetId]);
  const accountId = sheetAccountId(sheet);
  const title = sheet ? sheetName(sheet) : '';

  const {
    preset, startDate, endDate, applied, dateRestriction, dateFilterLocked, presetOptions, presetLabel,
    customDatesIncomplete, onPreset, applyDates, setStartDate, setEndDate,
  } = usePresetDateRange(user, sheetId);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [error, setError] = useState(null);

  const activeSnapshot = useMemo(
    () => (sheet ? mergePresetWithDates(sheet.snapshot, { startDate: applied.startDate, endDate: applied.endDate, preset }) : null),
    [sheet, applied.startDate, applied.endDate, preset]
  );

  useEffect(() => {
    if (!activeSnapshot || !accountId) return undefined;
    const base = snapshotToRoiSummaryParams(activeSnapshot);
    if (!base) {
      setData(null);
      setError('Select a date range and click Apply dates.');
      return undefined;
    }
    let cancelled = false;
    // New account / dates: drop the previous numbers so they are not shown (or merged) while these load.
    setData(null);
    setLoading(true);
    setBreakdownLoading(true);
    setError(null);

    // An app's revenue often sits on its quiz subdomains (Firebase links), not on the app id. So the account's apps are
    // looked up first and their subdomains are part of every request: cards, tables and exports then agree.
    const findSites = async () => {
      try {
        const rel = await adsAPI.listRoiRelatedTargets({ start: base.start, end: base.end, accountIds: accountId });
        const apps = [...new Set(((rel?.data !== undefined ? rel.data : rel)?.apps || []).map((a) => String(a.id || '').toLowerCase()).filter(Boolean))].slice(0, 200);
        if (!apps.length) return [];
        const replies = networkIds.length > 1
          ? await Promise.all(networkIds.map((id) => adsAPI.resolveFirebaseSites(apps, false, id).catch(() => null)))
          : [await adsAPI.resolveFirebaseSites(apps)];
        const bodies = replies.filter(Boolean).map((res) => (res && res.data !== undefined ? res.data : res));
        return [...new Set(bodies.flatMap((b) => (b?.results || []).flatMap((r) => [...(r.manualSites || []), ...(r.autoSites || [])])))];
      } catch (err) {
        logErrorForDebug(err, 'ROI sheet sites');
        return [];
      }
    };

    (async () => {
      const sites = await findSites();
      if (cancelled) return;
      const params = sites.length ? { ...base, siteKeys: sites.join(','), targetType: 'all' } : base;
      const failed = {};
      const summaryPromise = roiAPI.summary({ ...params, summaryOnly: '1' })
        .then((fast) => {
          if (cancelled) return;
          setData((prev) => mergeRoiSummaryPayload(prev, fast));
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          failed.summary = err;
          logErrorForDebug(err, 'ROI sheet summary');
        });
      // includeDaily: a one-day range must still return its day row.
      const breakdownPromise = roiAPI.summary({ ...params, breakdownOnly: '1', includeDaily: '1' })
        .then((bd) => {
          if (cancelled) return;
          setData((prev) => mergeRoiBreakdownPayload(prev, bd));
          setBreakdownLoading(false);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          failed.breakdown = err;
          logErrorForDebug(err, 'ROI sheet breakdown');
        });
      await Promise.all([summaryPromise, breakdownPromise]);
      if (cancelled) return;
      if (failed.summary && failed.breakdown) {
        setData(null);
        setError(getUserFacingMessage(failed.summary, 'Could not load ROI for this sheet.'));
      } else if (failed.summary) {
        setError(getUserFacingMessage(failed.summary, 'Could not load the ROI cards.'));
      }
      setLoading(false);
      setBreakdownLoading(false);
    })();
    return () => { cancelled = true; };
  }, [sheetId, accountId, netKey, activeSnapshot?.startDate, activeSnapshot?.endDate]);

  const summary = data?.summary || {};
  const spendCurrency = summary.adsSpendCurrency || data?.spendCurrency || 'USD';
  const countryTargetBreakdown = data?.countryTargetBreakdown || [];
  const dailyRows = data?.countryTargetDailyBreakdown || [];
  const inventoryEarn = useMemo(() => sumInventoryEarnFromBreakdown(countryTargetBreakdown), [countryTargetBreakdown]);

  const deleteSheet = async () => {
    const ok = await confirmDialog({
      title: 'Remove this sheet?',
      message: `"${title}" is removed from the sidebar. The Ads account and its data are not affected.`,
      yesLabel: 'Remove',
      noLabel: 'Keep',
    });
    if (!ok) return;
    removeRoiSheet(sheet.id, user?.id);
    navigate('/roi');
  };

  if (!sheet) {
    return (
      <div className="presets-detail-empty" role="status">
        <div className="warn-card-title">Sheet not found</div>
        <p className="form-note" style={{ margin: '8px 0 0' }}>
          This sheet was removed or belongs to another user. <Link to="/roi">Back to ROI</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="presets-roi-detail roi-sheet">
      <PageHeader
        title={title}
        subtitle="ROI sheet — spend, earnings and ROI for this Ads account"
        summary={applied.startDate ? (applied.startDate === applied.endDate ? applied.startDate : `${applied.startDate} → ${applied.endDate}`) : null}
      >
        <RoiCurrencySelect />
        <Link className="btn-outline-action" to="/roi">Open ROI</Link>
        <button type="button" className="btn-reset" onClick={deleteSheet}>Remove sheet</button>
      </PageHeader>

      <PresetDateToolbar
        preset={preset}
        startDate={startDate}
        endDate={endDate}
        presetLabel={presetLabel}
        presetOptions={presetOptions}
        customDatesIncomplete={customDatesIncomplete}
        dateFilterLocked={dateFilterLocked}
        dateRestriction={dateRestriction}
        onPreset={onPreset}
        onStartDateChange={setStartDate}
        onEndDateChange={setEndDate}
        onApply={applyDates}
      />

      {error ? <div className="login-error" style={{ marginTop: 12 }}>{error}</div> : null}

      <RoiSummaryBoards summary={summary} loading={loading} showLive={false} />

      <RoiInventoryEarnOverview
        appEarn={inventoryEarn.appEarn}
        siteEarn={inventoryEarn.siteEarn}
        totalEarn={inventoryEarn.totalEarn}
        currency={spendCurrency}
        loading={(loading || breakdownLoading) && !countryTargetBreakdown.length}
      />

      <RoiDateTable
        dailyRows={dailyRows}
        loading={breakdownLoading}
        currency={spendCurrency}
        groupBy="day"
        titleSuffix={`for ${title}`}
        exportName={`roi_sheet_${title.replace(/[^a-z0-9]+/gi, '_')}_day_${applied.startDate || 'x'}_${applied.endDate || 'y'}`}
      />
    </div>
  );
}
