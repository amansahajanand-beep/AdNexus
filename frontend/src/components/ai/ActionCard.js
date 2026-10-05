import React from 'react';

/**
 * A step the chat prepared. Nothing has happened yet: saving or changing something needs a click on Confirm,
 * and opening a page needs a click on Open. `state` is { status: 'running' | 'done' | 'error' | 'cancelled', message, href, linkLabel }.
 */
export default function ActionCard({ action, state, onConfirm, onCancel, onLink }) {
  const status = state?.status || 'idle';
  const running = status === 'running';
  const finished = status === 'done' || status === 'cancelled';

  return (
    <div className={`act-card ${status}`} role="group" aria-label={action.title}>
      <span className="act-icon" aria-hidden="true">
        {action.type === 'open_page' ? '↗' : action.type === 'save_preset' ? '★' : '◎'}
      </span>
      <div className="act-body">
        <b className="act-title">{action.title}</b>
        {action.detail ? <span className="act-detail">{action.detail}</span> : null}
        {status === 'done' ? (
          <span className="act-result ok">
            ✓ {state.message}
            {state.href ? <button type="button" className="act-link" onClick={() => onLink(state.href)}>{state.linkLabel || 'Open'}</button> : null}
          </span>
        ) : null}
        {status === 'cancelled' ? <span className="act-result">Cancelled.</span> : null}
        {status === 'error' ? <span className="act-result bad" role="alert">{state.message}</span> : null}
      </div>
      {!finished ? (
        <div className="act-buttons">
          {action.confirm ? (
            <>
              <button type="button" className="act-confirm" disabled={running} onClick={onConfirm}>
                {running ? 'Working…' : status === 'error' ? 'Try again' : 'Confirm'}
              </button>
              <button type="button" className="act-cancel" disabled={running} onClick={onCancel}>Cancel</button>
            </>
          ) : (
            <button type="button" className="act-confirm" disabled={running} onClick={onConfirm}>Open</button>
          )}
        </div>
      ) : null}
    </div>
  );
}
