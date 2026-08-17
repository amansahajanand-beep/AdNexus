import React, { useState, useEffect } from 'react';

const STORAGE_KEY = 'adnexus.guide.v1';

/**
 * First-run guide: Pick dates → Apply → Explore charts.
 * Dismiss persists in localStorage.
 */
export default function OnboardingGuide({
  visible = true,
  onDismiss,
  onPickDates,
  onApply,
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!visible) {
      setOpen(false);
      return;
    }
    try {
      if (localStorage.getItem(STORAGE_KEY) === 'done') {
        setOpen(false);
        return;
      }
    } catch {
      /* ignore */
    }
    setOpen(true);
  }, [visible]);

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'done');
    } catch {
      /* ignore */
    }
    setOpen(false);
    onDismiss?.();
  };

  if (!open) return null;

  return (
    <div className="onboard-guide" role="region" aria-label="Getting started">
      <div className="onboard-guide-head">
        <h3 className="onboard-guide-title">Get started in 3 steps</h3>
        <button type="button" className="onboard-guide-dismiss" onClick={dismiss} aria-label="Dismiss guide">
          Dismiss
        </button>
      </div>
      <ol className="onboard-guide-steps">
        <li>
          <span className="onboard-step-num">1</span>
          <div>
            <strong>Pick dates</strong>
            <p>Choose Today, Last 7 days, or a custom range.</p>
            {onPickDates && (
              <button type="button" className="btn-reset onboard-step-btn" onClick={onPickDates}>
                Open date range
              </button>
            )}
          </div>
        </li>
        <li>
          <span className="onboard-step-num">2</span>
          <div>
            <strong>Apply Filter</strong>
            <p>Load live metrics for that range (shortcut: A).</p>
            {onApply && (
              <button type="button" className="btn-generate onboard-step-btn" onClick={onApply}>
                Apply Filter
              </button>
            )}
          </div>
        </li>
        <li>
          <span className="onboard-step-num">3</span>
          <div>
            <strong>Explore charts</strong>
            <p>Review KPIs, share charts, and drill into the table. Press / to search.</p>
          </div>
        </li>
      </ol>
      <p className="onboard-guide-hint">Tip: press R to reset filters · [ to toggle focus mode on the sidebar</p>
    </div>
  );
}
