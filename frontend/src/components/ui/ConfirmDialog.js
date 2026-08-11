import React from 'react';
import Modal from './Modal';
import Button from './Button';

/**
 * Centered confirm/alert dialog replacing window.confirm and window.alert.
 *
 * Props:
 *   open        – boolean
 *   title       – heading text
 *   message     – body text
 *   type        – 'confirm' (default) | 'alert' | 'danger'
 *   confirmLabel – button label (default: 'Confirm')
 *   cancelLabel  – button label (default: 'Cancel')
 *   onConfirm   – called when user clicks confirm
 *   onCancel    – called when user clicks cancel / closes (not shown for type='alert')
 *   icon        – optional emoji/icon string
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  type = 'confirm',
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  icon,
}) {
  const isAlert = type === 'alert';
  const isDanger = type === 'danger';

  const defaultIcon = isDanger ? '🗑' : isAlert ? 'ℹ️' : '❓';
  const displayIcon = icon || defaultIcon;
  const displayConfirmLabel = confirmLabel || (isDanger ? 'Delete' : isAlert ? 'OK' : 'Confirm');

  const footer = (
    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
      {!isAlert && (
        <Button variant="secondary" onClick={onCancel}>{cancelLabel}</Button>
      )}
      <Button
        variant={isDanger ? 'danger' : 'primary'}
        onClick={onConfirm}
      >
        {displayConfirmLabel}
      </Button>
    </div>
  );

  return (
    <Modal
      open={open}
      title={null}
      onClose={isAlert ? onConfirm : onCancel}
      footer={footer}
      width={400}
    >
      <div style={{ textAlign: 'center', padding: '8px 0 4px' }}>
        <div style={{ fontSize: 44, marginBottom: 14, lineHeight: 1 }}>{displayIcon}</div>
        {title && (
          <div style={{ fontWeight: 700, fontSize: 17, color: isDanger ? '#c62828' : '#202124', marginBottom: 10 }}>
            {title}
          </div>
        )}
        {message && (
          <div style={{ color: '#3c4043', fontSize: 14, lineHeight: 1.6 }}>
            {message}
          </div>
        )}
      </div>
    </Modal>
  );
}
