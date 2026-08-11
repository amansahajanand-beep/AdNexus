import React from 'react';

/**
 * Reusable button.
 * variant: 'primary' | 'secondary' | 'ghost' | 'danger' | 'link'
 */
export default function Button({
  variant = 'primary',
  type = 'button',
  loading = false,
  disabled = false,
  icon = null,
  children,
  className = '',
  ...rest
}) {
  return (
    <button
      type={type}
      className={`ui-btn ui-btn-${variant} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="ui-btn-spinner" /> : icon}
      {children}
    </button>
  );
}
