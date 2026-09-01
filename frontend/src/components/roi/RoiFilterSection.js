import React from 'react';

/**
 * Grouped filter block with title + subtitle (Ads & inventory, Date range, etc.).
 */
export default function RoiFilterSection({ title, subtitle, children, className = '' }) {
  return (
    <section className={`roi-filter-section ${className}`.trim()}>
      <div className="roi-filter-section-head">
        <h3 className="roi-filter-section-title">{title}</h3>
        {subtitle ? <p className="roi-filter-section-sub">{subtitle}</p> : null}
      </div>
      <div className="roi-filter-stack">{children}</div>
    </section>
  );
}
