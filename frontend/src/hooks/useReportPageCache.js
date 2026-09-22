import { useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { saveReportPage } from '../store/slices/reportSlice';

/**
 * Hydrate from Redux on mount; persist snapshot; skip API when cache is fresh.
 */
export function useReportPageCache(pageKey, snapshot, { cacheTtlMs, onSkipLoad }) {
  const dispatch = useDispatch();
  const saved = useSelector((s) => s.reports?.[pageKey]);
  const skipOnce = useRef(isReportCacheFresh(saved, cacheTtlMs));

  useEffect(() => {
    if (snapshot) {
      dispatch(saveReportPage({ pageKey, payload: snapshot }));
    }
  }, [dispatch, pageKey, snapshot]);

  useEffect(() => {
    if (skipOnce.current) {
      skipOnce.current = false;
      onSkipLoad?.(saved);
    }
  }, []);

  return { saved, shouldSkipInitialLoad: () => skipOnce.current };
}

/** True when we have usable cached payload within TTL for this GAM network. */
export function isReportCacheFresh(saved, ttlMs, { clientId = null } = {}) {
  if (!saved?.fetchedAt) return false;
  if (Date.now() - saved.fetchedAt >= ttlMs) return false;
  // Always require a clientId tag — never paint another network's KPIs.
  if (!saved.clientId) return false;
  if (clientId == null || String(saved.clientId) !== String(clientId)) return false;
  return Boolean(
    saved.data
    || saved.progData
    || saved.overviewData?.summary
    || saved.detailData?.summary
    || (Array.isArray(saved.detailData?.rows) && saved.detailData.rows.length)
  );
}

/** Cap detail rows so sessionStorage persist stays snappy. */
export function slimDetailForCache(detail, maxRows = 200) {
  if (!detail) return null;
  const rows = Array.isArray(detail.rows) ? detail.rows.slice(0, maxRows) : [];
  return {
    summary: detail.summary,
    trend: detail.trend,
    charts: detail.charts,
    rows,
    status: detail.status,
    visibility: detail.visibility,
    pagination: detail.pagination
      ? { ...detail.pagination, returnedRows: rows.length }
      : undefined,
    reportWarning: detail.reportWarning,
    reportWarningSkipped: detail.reportWarningSkipped,
    isMock: detail.isMock,
  };
}

/** Cap ROI country trees for persist without dropping overview cards. */
export function slimRoiForCache(data) {
  if (!data) return null;
  const cap = (arr, n = 500) => (Array.isArray(arr) ? arr.slice(0, n) : arr);
  return {
    ...data,
    countryBreakdown: cap(data.countryBreakdown, 300),
    countryTargetBreakdown: cap(data.countryTargetBreakdown, 800),
    countryTargetDailyBreakdown: cap(data.countryTargetDailyBreakdown, 400),
    rows: cap(data.rows, 200),
  };
}
