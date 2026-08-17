import React, { useEffect } from 'react';
import { useToasts } from '../../hooks/useToast';

function ToastItem({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast.timeout) return undefined;
    const id = setTimeout(() => onDismiss(toast.id), toast.timeout);
    return () => clearTimeout(id);
  }, [toast.id, toast.timeout, onDismiss]);

  return (
    <div className="app-toast" role="status">
      <span className="app-toast-msg">{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button
          type="button"
          className="app-toast-action"
          onClick={() => {
            toast.onAction();
            onDismiss(toast.id);
          }}
        >
          {toast.actionLabel}
        </button>
      )}
      <button type="button" className="app-toast-x" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
        ×
      </button>
    </div>
  );
}

export default function ToastStack() {
  const { toasts, dismiss } = useToasts();
  if (!toasts.length) return null;
  return (
    <div className="app-toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  );
}
