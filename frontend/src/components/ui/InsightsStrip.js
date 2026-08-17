import React from 'react';

export default function InsightsStrip({ items = [], compareLabel = 'vs prior period' }) {
  if (!items.length) return null;
  return (
    <div className="insights-strip" role="status">
      <div className="insights-strip-head">
        <span className="insights-strip-title">What changed</span>
        <span className="insights-strip-hint">{compareLabel}</span>
      </div>
      <ul className="insights-strip-list">
        {items.map((item) => (
          <li key={item.id} className={`insights-strip-item is-${item.tone || 'neutral'}`}>
            {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
