import { useCallback, useEffect, useState } from 'react';

const TOAST_EVENT = 'adnexus-toast';

export function showToast({
  message,
  actionLabel,
  onAction,
  timeout = 4200,
} = {}) {
  if (!message) return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, {
    detail: {
      id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      message,
      actionLabel: actionLabel || null,
      onAction: onAction || null,
      timeout,
    },
  }));
}

export function useToasts() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const onToast = (e) => {
      const t = e.detail;
      if (!t?.message) return;
      setToasts((prev) => [...prev.slice(-2), t]);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, dismiss };
}
