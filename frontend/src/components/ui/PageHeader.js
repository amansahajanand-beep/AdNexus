import React from 'react';

/**
 * Shared analytics page chrome: title, subtitle, optional filter summary, optional actions.
 */
export default function PageHeader({
  title,
  subtitle,
  summary,
  children,
  className = '',
}) {
  return (
    <div className={`page-head ${className}`.trim()}>
      <div className="page-head-main">
        <h2 className="page-title">{title}</h2>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
        {summary ? <p className="page-filter-summary">{summary}</p> : null}
      </div>
      {children ? <div className="page-head-actions">{children}</div> : null}
    </div>
  );
}
