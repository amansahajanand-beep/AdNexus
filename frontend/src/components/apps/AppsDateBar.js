import React, { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RANGES, DEFAULT_RANGE, normalizeRange, getRangeInfo } from '../../mocks/appsData';

/** The selected date range lives in the URL (?range=7d) so it survives refresh and navigation. */
export function useAppsRange() {
  const [params, setParams] = useSearchParams();
  const range = normalizeRange(params.get('range') || DEFAULT_RANGE);
  const setRange = useCallback((next) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('range', next);
      return p;
    }, { replace: true });
  }, [setParams]);
  return [range, setRange];
}

export const appsListPath = (range) => `/apps?range=${range}`;
export const appDetailPath = (slug, range, tab) => (
  `/apps/${slug}?range=${range}${tab && tab !== 'report' ? `&tab=${tab}` : ''}`);

export default function AppsDateBar({ value, onChange }) {
  const info = getRangeInfo(value);
  return (
    <div className="apps-datebar">
      <div className="apps-datebar-pills" role="group" aria-label="Date range">
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`apps-datebar-btn${value === r.id ? ' is-active' : ''}`}
            aria-pressed={value === r.id}
            onClick={() => onChange(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>
      <span className="apps-datebar-span">
        {info.spanLabel}
        {info.prevSpanLabel ? <span className="apps-datebar-prev"> · vs {info.prevSpanLabel}</span> : null}
      </span>
    </div>
  );
}
