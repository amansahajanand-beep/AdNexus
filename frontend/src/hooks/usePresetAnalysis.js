import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadAiStatus, streamPresetAnalysis } from '../utils/ai/presetAnalysis';

const START_DELAY_MS = 250;

const IDLE = { phase: 'idle', early: null, headline: null, result: null, error: null };

/**
 * Loads the AI analysis for one preset and date range.
 * Starts automatically (summary tier) while `active`, restarts when the preset or dates change,
 * and cancels the request it replaces. `analyze('deep')` runs the deeper tier on demand.
 */
export default function usePresetAnalysis({
  product, kind, filters, startDate, endDate, active = true,
}) {
  const [enabled, setEnabled] = useState(null); // null = still checking
  const [fast, setFast] = useState(IDLE);
  const [deep, setDeep] = useState(IDLE);
  const controllers = useRef({ fast: null, deep: null });

  useEffect(() => {
    let alive = true;
    loadAiStatus().then((s) => { if (alive) setEnabled(Boolean(s?.enabled)); });
    return () => { alive = false; };
  }, []);

  const requestKey = useMemo(
    () => JSON.stringify({ product, kind, filters, startDate, endDate }),
    [product, kind, filters, startDate, endDate]
  );

  const analyze = useCallback(async (depth = 'fast', { force = false } = {}) => {
    if (!startDate || !endDate) return;
    const setState = depth === 'deep' ? setDeep : setFast;
    controllers.current[depth]?.abort();
    const controller = new AbortController();
    controllers.current[depth] = controller;
    setState({ ...IDLE, phase: 'loading' });
    try {
      const result = await streamPresetAnalysis(
        { product, kind, filters, startDate, endDate, depth, force },
        {
          signal: controller.signal,
          onFacts: (early) => { if (!controller.signal.aborted) setState((s) => ({ ...s, early })); },
          onHeadline: (headline) => { if (!controller.signal.aborted) setState((s) => ({ ...s, headline })); },
        }
      );
      // `early` (key figures and chart data) stays on screen once the full result arrives.
      if (!controller.signal.aborted) setState((s) => ({ ...IDLE, phase: 'ready', result, early: s.early }));
    } catch (err) {
      if (controller.signal.aborted || err.name === 'AbortError') return;
      setState({ ...IDLE, phase: 'error', error: { message: err.message, code: err.code, status: err.status } });
    }
    // requestKey carries the identity of every input used above.
  }, [requestKey]);

  // Run the summary when it is wanted; a new preset or date range replaces the previous request.
  useEffect(() => {
    if (!active || !enabled || !startDate || !endDate) return undefined;
    setDeep(IDLE);
    const t = setTimeout(() => analyze('fast'), START_DELAY_MS);
    return () => {
      clearTimeout(t);
      controllers.current.fast?.abort();
      controllers.current.deep?.abort();
    };
  }, [active, enabled, requestKey, analyze, startDate, endDate]);

  useEffect(() => () => {
    controllers.current.fast?.abort();
    controllers.current.deep?.abort();
  }, []);

  return { enabled, fast, deep, analyze };
}
