import React, { useEffect } from 'react';

/**
 * Centered success/alert modal matching the app design.
 */
export default function SuccessModal({
  open, icon = '💾', iconBg = '#eef2ff', title = 'Successful Changes',
  children, onClose, btnLabel = 'Okay', btnColor = '#4f6ef7',
}) {
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
    <div
      className="success-modal-overlay"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="success-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="success-modal-title"
      >
        <button
          type="button"
          className="success-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
        <div
          className="success-modal-icon"
          style={{ background: iconBg }}
        >
          {icon}
        </div>
        <div className="success-modal-title" id="success-modal-title">{title}</div>
        {children && (
          <div className="success-modal-body">
            {children}
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          className="success-modal-btn"
          style={{ background: btnColor }}
        >
          {btnLabel}
        </button>
      </div>
    </div>
  );
}
