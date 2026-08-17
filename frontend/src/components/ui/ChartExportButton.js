import React, { useRef, useState } from 'react';
import { exportChartAsPng } from '../../utils/chartExport';

/** Small PNG download control for a parent `.chart-card`. */
export default function ChartExportButton({ filename = 'chart', label = 'PNG' }) {
  const btnRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const onClick = async (e) => {
    e.stopPropagation();
    if (busy) return;
    const card = btnRef.current?.closest('.chart-card');
    if (!card) return;
    setBusy(true);
    try {
      await exportChartAsPng(card, filename);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      ref={btnRef}
      type="button"
      className="chart-export-btn"
      onClick={onClick}
      disabled={busy}
      title="Download chart as PNG"
    >
      {busy ? '…' : label}
    </button>
  );
}
