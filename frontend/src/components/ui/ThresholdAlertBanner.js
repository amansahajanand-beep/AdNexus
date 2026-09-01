import React from 'react';

/** Inline threshold / warning banners (ROI negative, revenue drop, etc.). */
export default function ThresholdAlertBanner({ items = [], onDismiss }) {
  if (!items?.length) return null;
  return (
    <div className="threshold-alerts" role="status">
      {items.map((item) => (
        <div
          key={item.id}
          className={`threshold-alert threshold-alert--${item.tone || 'danger'}`}
        >
          <div className="threshold-alert-body">
            <div className="threshold-alert-title">{item.title}</div>
            {item.message ? (
              <div className="threshold-alert-msg">{item.message}</div>
            ) : null}
          </div>
          {onDismiss ? (
            <button
              type="button"
              className="threshold-alert-dismiss"
              aria-label="Dismiss"
              onClick={() => onDismiss(item.id)}
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
