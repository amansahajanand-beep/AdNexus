import { useState, useEffect, useCallback, useRef } from 'react';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';

export function useAPI(apiFn, deps = [], options = {}) {
  const { autoFetch = true, pollInterval = null } = options;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(autoFetch);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFn();
      setData(result);
    } catch (err) {
      logErrorForDebug(err, 'useAPI');
      setError(getUserFacingMessage(err));
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => {
    if (autoFetch) fetch();
  }, [fetch, autoFetch]);

  // Optional polling for live data
  useEffect(() => {
    if (pollInterval) {
      intervalRef.current = setInterval(fetch, pollInterval);
      return () => clearInterval(intervalRef.current);
    }
  }, [fetch, pollInterval]);

  return { data, loading, error, refetch: fetch };
}

export function useReports(days = 30) {
  const { reportsAPI } = require('../utils/api');
  const summary = useAPI(() => reportsAPI.getSummary(days), [days], { pollInterval: 5 * 60 * 1000 });
  const trend = useAPI(() => reportsAPI.getTrend(days, 'revenue'), [days]);
  const byAdType = useAPI(() => reportsAPI.getByAdType(), []);
  const topAdvertisers = useAPI(() => reportsAPI.getTopAdvertisers(), []);

  return { summary, trend, byAdType, topAdvertisers };
}
