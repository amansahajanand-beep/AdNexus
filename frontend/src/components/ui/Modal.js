import React, { useEffect } from 'react';

/**
 * Reusable centered modal dialog.
 * Props: open, title, onClose, footer, children, width
 */
export default function Modal({ open, title, onClose, footer, children, width = 480, className = '' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ui-modal-overlay" onMouseDown={onClose}>
      <div
        className={`ui-modal${className ? ` ${className}` : ''}`}
        style={{ maxWidth: `min(${width}px, calc(100vw - 24px))` }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ui-modal-title"
      >
        <div className="ui-modal-head">
          <h3 className="ui-modal-title" id="ui-modal-title">{title}</h3>
          <button className="ui-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="ui-modal-body">{children}</div>
        {footer && <div className="ui-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
