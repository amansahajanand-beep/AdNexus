import { useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { saveReportPage } from '../store/slices/reportSlice';

/**
 * Hydrate from Redux on mount; persist snapshot; skip API when cache is fresh.
 */
export function useReportPageCache(pageKey, snapshot, { cacheTtlMs, onSkipLoad }) {
  const dispatch = useDispatch();
  const saved = useSelector((s) => s.reports?.[pageKey]);
  const skipOnce = useRef(
    !!(saved?.fetchedAt && saved?.data && Date.now() - saved.fetchedAt < cacheTtlMs)
  );

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

export function isReportCacheFresh(saved, ttlMs) {
  return !!(saved?.fetchedAt && saved?.data && Date.now() - saved.fetchedAt < ttlMs);
}
