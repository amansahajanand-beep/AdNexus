import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Globe2, Check, ChevronDown } from 'lucide-react';

/** "UTC+8", "UTC−7", "UTC+5:30" for an IANA zone right now. */
export function utcOffsetLabel(tz, date = new Date()) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value || '';
    const m = part.match(/GMT([+-−])?(\d{1,2})?(?::(\d{2}))?/);
    if (!m || !m[2]) return 'UTC';
    return `UTC${m[1] === '-' ? '−' : '+'}${Number(m[2])}${m[3] ? `:${m[3]}` : ''}`;
  } catch {
    return '';
  }
}

function clockIn(tz) {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date());
  } catch {
    return '';
  }
}

function formatShortDate(ymd) {
  try {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  } catch {
    return ymd;
  }
}

/**
 * Admin timezone dropdown for the Dashboard. `value` is '' for the network timezone. A short note beside it says
 * where the hourly data starts, so it is clear which days the zone applies to.
 */
export default function TimezoneSwitcher({ networkTz, options, value, hourlyFrom, stale = false, onChange }) {
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const rootRef = useRef(null);
  const active = value || networkTz;
  const activeOption = options.find((o) => o.id === active) || options[0];
  const isNetwork = active === networkTz;

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const clock = setInterval(() => tick((n) => n + 1), 30000);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      clearInterval(clock);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const pick = (id) => {
    close();
    if (id !== active) onChange(id);
  };

  return (
    <div className="tz-switcher" ref={rootRef}>
      <div className="tz-dropdown">
        <button
          type="button"
          className={`tz-trigger${open ? ' is-open' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Timezone: ${activeOption?.label}. Change`}
          onClick={() => setOpen((v) => !v)}
        >
          <Globe2 size={15} strokeWidth={1.75} aria-hidden />
          <span className="tz-trigger-name">{activeOption?.label}</span>
          <span className="tz-trigger-offset">{utcOffsetLabel(active)}</span>
          <ChevronDown size={14} strokeWidth={2} className="tz-trigger-chevron" aria-hidden />
        </button>

        {open && (
          <ul className="tz-menu" role="listbox" aria-label="Choose timezone">
            {options.map((o) => {
              const selected = o.id === active;
              return (
                <li key={o.id} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`tz-option${selected ? ' is-active' : ''}`}
                    onClick={() => pick(o.id)}
                  >
                    <span className="tz-option-check">{selected && <Check size={14} strokeWidth={2.5} aria-hidden />}</span>
                    <span className="tz-option-name">
                      {o.label}
                      {o.approx && (
                        <span className="tz-approx" title="This zone is not a whole number of hours from the network timezone, so the boundary hour is shared evenly between its two days.">≈</span>
                      )}
                    </span>
                    <span className="tz-option-meta">
                      <span>{utcOffsetLabel(o.id)}</span>
                      <span className="tz-option-time">{clockIn(o.id)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <span className={`tz-note${isNetwork ? '' : hourlyFrom && !stale ? ' is-ok' : ' is-wait'}`} role="status">
        {isNetwork && 'Network timezone'}
        {!isNetwork && hourlyFrom && stale && 'The latest hours are still being fetched — today may show network-timezone figures until they arrive'}
        {!isNetwork && hourlyFrom && !stale && <>Days from <strong>{formatShortDate(hourlyFrom)}</strong> use this timezone; earlier days stay in the network timezone</>}
        {!isNetwork && !hourlyFrom && 'Hourly data is still loading — showing the network timezone for now'}
      </span>
    </div>
  );
}
