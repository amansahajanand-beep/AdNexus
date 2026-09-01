import React, { useState } from 'react';

const EyeIcon = ({ off }) => (
  off ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
);

/**
 * Labelled text/password input.
 * Password fields automatically get a show/hide (eye) toggle.
 */
export function TextField({ label, type = 'text', value, onChange, placeholder, autoFocus, ...rest }) {
  const [show, setShow] = useState(false);
  const isPassword = type === 'password';
  const inputType = isPassword && show ? 'text' : type;

  return (
    <label className="ui-field">
      {label && <span className="ui-field-label">{label}</span>}
      <span className={`ui-input-wrap ${isPassword ? 'has-toggle' : ''}`}>
        <input
          className="ui-field-input"
          type={inputType}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          {...rest}
        />
        {isPassword && (
          <button
            type="button"
            className="ui-pw-toggle"
            onClick={() => setShow((s) => !s)}
            tabIndex={-1}
            aria-label={show ? 'Hide password' : 'Show password'}
            title={show ? 'Hide password' : 'Show password'}
          >
            <EyeIcon off={show} />
          </button>
        )}
      </span>
    </label>
  );
}

/**
 * Password input — always masked (••••) unless allowReveal is true.
 * Starts empty; blocks browser autofill of saved login password on profile forms.
 */
export function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  autoComplete = 'off',
  allowReveal = false,
  disabled = false,
  locked = false,
  ...rest
}) {
  const [show, setShow] = useState(false);
  const [blockAutofill, setBlockAutofill] = useState(!disabled && !locked);
  const masked = !allowReveal || !show;

  return (
    <label className={`ui-field ${disabled ? 'ui-field--disabled' : ''}`}>
      {label && <span className="ui-field-label">{label}</span>}
      <span className={`ui-input-wrap ${allowReveal ? 'has-toggle' : ''}`}>
        <input
          className={`ui-field-input ui-field-input--password${locked ? ' ui-field-input--locked' : ''}`}
          type={locked || masked ? 'password' : 'text'}
          value={value}
          onChange={disabled || locked ? undefined : (e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          autoComplete={locked ? 'off' : autoComplete}
          readOnly={locked || (!disabled && blockAutofill)}
          disabled={disabled}
          onFocus={() => {
            if (!disabled && !locked) setBlockAutofill(false);
          }}
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          {...rest}
        />
        {allowReveal && !disabled && !locked && (
          <button
            type="button"
            className="ui-pw-toggle"
            onClick={() => setShow((s) => !s)}
            tabIndex={-1}
            aria-label={show ? 'Hide password' : 'Show password'}
            title={show ? 'Hide password' : 'Show password'}
          >
            <EyeIcon off={show} />
          </button>
        )}
      </span>
    </label>
  );
}

/**
 * Labelled select dropdown.
 * options: [{ value, label }]
 */
export function SelectField({
  label, value, onChange, options = [], placeholder, loading = false, disabled = false, ...rest
}) {
  return (
    <label className={`ui-field ${loading ? 'ui-field-loading' : ''}`}>
      {label && <span className="ui-field-label">{label}</span>}
      <span className="ui-select-wrap">
        {loading && <span className="ui-select-spinner" aria-hidden />}
        <select
          className="ui-field-input"
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          disabled={loading || disabled}
          {...rest}
        >
          {loading
            ? <option value="">Loading…</option>
            : <>
                {placeholder && <option value="">{placeholder}</option>}
                {options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </>
          }
        </select>
      </span>
    </label>
  );
}
