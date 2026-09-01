import React, { useEffect } from 'react';

/**
 * Yes / No confirm dialog — green check + red cross.
 * Use via confirmDialog() from hooks/useConfirmDialog, or render directly.
 */
export default function ConfirmDialog({
  open,
  title = 'Are you sure?',
  message,
  yesLabel = 'Yes',
  noLabel = 'No',
  onYes,
  onNo,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onNo?.();
      if (e.key === 'Enter') onYes?.();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onYes, onNo]);

  if (!open) return null;

  return (
    <div
      className="confirm-dialog-overlay"
      onMouseDown={onNo}
      role="presentation"
    >
      <div
        className="confirm-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <button
          type="button"
          className="confirm-dialog-close"
          onClick={onNo}
          aria-label="Close"
        >
          ×
        </button>
        <div className="confirm-dialog-icon" aria-hidden>
          ?
        </div>
        {title ? (
          <div className="confirm-dialog-title" id="confirm-dialog-title">
            {title}
          </div>
        ) : null}
        {message ? (
          <div className="confirm-dialog-message">{message}</div>
        ) : null}
        <div className="confirm-dialog-actions">
          <button
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn--no"
            onClick={onNo}
          >
            <span className="confirm-dialog-btn-icon" aria-hidden>✕</span>
            {noLabel}
          </button>
          <button
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn--yes"
            onClick={onYes}
            autoFocus
          >
            <span className="confirm-dialog-btn-icon" aria-hidden>✓</span>
            {yesLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
