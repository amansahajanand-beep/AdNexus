import React, { useCallback, useEffect, useState } from 'react';
import ConfirmDialog from '../components/ui/ConfirmDialog';

const CONFIRM_EVENT = 'adnexus-confirm';

/**
 * Promise-based confirm. Resolves true on Yes, false on No / dismiss.
 * Requires ConfirmDialogHost mounted in the app shell (Layout).
 *
 *   const ok = await confirmDialog({ title: 'Delete?', message: '…' });
 */
export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  yesLabel = 'Yes',
  noLabel = 'No',
} = {}) {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent(CONFIRM_EVENT, {
      detail: {
        id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title,
        message,
        yesLabel,
        noLabel,
        resolve,
      },
    }));
  });
}

/** Mount once under Layout so confirmDialog() can show the dialog. */
export function ConfirmDialogHost() {
  const [state, setState] = useState(null);

  useEffect(() => {
    const onConfirm = (e) => {
      const detail = e.detail;
      if (!detail?.resolve) return;
      setState((prev) => {
        // If a previous dialog is still open, treat it as No.
        if (prev?.resolve) prev.resolve(false);
        return detail;
      });
    };
    window.addEventListener(CONFIRM_EVENT, onConfirm);
    return () => window.removeEventListener(CONFIRM_EVENT, onConfirm);
  }, []);

  const finish = useCallback((value) => {
    setState((prev) => {
      if (prev?.resolve) prev.resolve(value);
      return null;
    });
  }, []);

  return (
    <ConfirmDialog
      open={!!state}
      title={state?.title}
      message={state?.message}
      yesLabel={state?.yesLabel}
      noLabel={state?.noLabel}
      onYes={() => finish(true)}
      onNo={() => finish(false)}
    />
  );
}
