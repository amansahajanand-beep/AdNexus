import React from 'react';
import { buildFreshnessHint } from '../../utils/report/dataFreshness';

/**
 * Shows range coverage and GAM reconciliation freshness on Dashboard/Reporting.
 */
export default function DataFreshness({
  coverage,
  networkInfo,
  status,
  className = '',
}) {
  const hint = buildFreshnessHint({ coverage, networkInfo, status });
  if (!hint) return null;

  const partial = status === 'partial' || (coverage && !coverage.complete);
  const fixing = networkInfo?.reconciliationStatus === 'fixing';
  const divergent = networkInfo?.reconciliationStatus === 'divergent';

  let tone = 'freshness-ok';
  if (fixing) tone = 'freshness-fixing';
  else if (divergent) tone = 'freshness-warn';
  else if (partial) tone = 'freshness-partial';

  return (
    <span className={`data-freshness ${tone} ${className}`.trim()} title={hint}>
      {fixing && <span className="dot-pulse" aria-hidden="true" />}
      {hint}
    </span>
  );
}
