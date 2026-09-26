import { useCallback, useEffect, useState } from 'react';

const TOAST_EVENT = 'adnexus-toast';

/**
 * Show a toast. Pass replaceKey (or reuse the same message) to replace an
 * existing toast instead of stacking duplicates on rapid Apply/Reset.
 */
export function showToast({
  message,
  actionLabel,
  onAction,
  timeout = 4200,
  replaceKey = null,
} = {}) {
  if (!message) return;
  const key = replaceKey || message;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, {
    detail: {
      id: `t_${key}_${Date.now()}`,
      replaceKey: key,
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
      setToasts((prev) => {
        const key = t.replaceKey || t.message;
        const without = prev.filter((x) => (x.replaceKey || x.message) !== key);
        return [...without.slice(-2), t];
      });
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, dismiss };
}
