import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { aiAPI } from '../../utils/api';
import { loadAiStatus } from '../../utils/ai/presetAnalysis';
import ExplainChange from '../ai/ExplainChange';
import { showToast } from '../../hooks/useToast';

const SEEN_KEY = 'adnexus.aiAlerts.seenAt';
const RECHECK_MS = 25_000;
const PRODUCT = { gam: 'GAM', admob: 'AdMob', adsense: 'AdSense' };
const PATHS = {
  gam: { dashboard: '/dashboard', roi: '/roi' },
  admob: { dashboard: '/admob/dashboard', roi: '/admob/roi' },
  adsense: { dashboard: '/adsense/dashboard', roi: '/adsense/roi' },
};
const SEVERITY = { critical: 'Needs action', warning: 'Watch' };
// Alerts about earnings moving can be explained; ROI, sync and mapping alerts cannot.
const EXPLAINABLE = new Set(['metric_drop', 'price_volume', 'anomaly', 'drop_off']);

function readSeen() {
  try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; }
}

function ago(iso) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/**
 * Sidebar bell: problems found in last week's numbers across GAM, AdMob and AdSense.
 * Shown to admins when AI is turned on. Opening the list marks everything in it as seen.
 */
export default function AiAlertsBell({ isAdmin, collapsed = false }) {
  const [enabled, setEnabled] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState(readSeen);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const wrapRef = useRef(null);

  const load = useCallback(async (isRecheck = false) => {
    try {
      const res = await aiAPI.alerts();
      setAlerts(res.alerts || []);
      setError(null);
      if (res.scanning && !isRecheck) setTimeout(() => load(true), RECHECK_MS);
    } catch {
      setError('Could not load alerts.');
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return undefined;
    let alive = true;
    loadAiStatus().then((s) => {
      if (!alive || !s?.enabled) return;
      setEnabled(true);
      load();
    });
    return () => { alive = false; };
  }, [isAdmin, load]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!isAdmin || !enabled) return null;

  const unread = alerts.filter((a) => Date.parse(a.createdAt) > seenAt).length;

  const toggle = () => {
    setOpen((o) => {
      if (!o) {
        const now = Date.now();
        try { localStorage.setItem(SEEN_KEY, String(now)); } catch { /* ignore */ }
        setSeenAt(now);
      }
      return !o;
    });
  };

  const dismiss = async (a) => {
    setAlerts((list) => list.filter((x) => x.id !== a.id));
    try { await aiAPI.dismissAlert(a.id); } catch { load(); }
  };

  const checkNow = async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await aiAPI.scanAlerts();
      setAlerts(res.alerts || []);
      showToast({
        message: res.created ? `Found ${res.created} new problem${res.created === 1 ? '' : 's'}.` : 'No new problems found.',
        replaceKey: 'ai-alerts-scan',
      });
    } catch {
      setError('Could not check right now. Try again in a moment.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="aib" ref={wrapRef}>
      <button
        type="button"
        className="sidebar-focus-toggle aib-btn"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="AI alerts"
      >
        <span className="sidebar-toggle-icon" aria-hidden="true">
          <BellIcon />
          {unread ? <span className="aib-badge">{unread > 9 ? '9+' : unread}</span> : null}
        </span>
        <span className="sidebar-focus-label">Alerts{unread ? ` (${unread})` : ''}</span>
      </button>

      {open ? (
        <div className={`aib-pop${collapsed ? ' is-collapsed' : ''}`} role="dialog" aria-label="AI alerts">
          <div className="aib-head">
            <b>Alerts</b>
            <span>Last 7 days</span>
          </div>
          {error ? <p className="aib-note" role="alert">{error}</p> : null}
          {alerts.length === 0 ? (
            <p className="aib-empty">Nothing needs attention right now.</p>
          ) : (
            <ul className="aib-list">
              {alerts.map((a) => {
                const path = PATHS[a.product]?.[a.page];
                return (
                  <li key={a.id} className="aib-item">
                    <div className="aib-meta">
                      <span className={`aib-sev ${a.severity}`}>{SEVERITY[a.severity] || 'Note'}</span>
                      <span className="aib-prod">{PRODUCT[a.product] || a.product}</span>
                      <span className="aib-time">{ago(a.createdAt)}</span>
                    </div>
                    <b className="aib-title">{a.title}</b>
                    <p className="aib-text">{a.text}</p>
                    {a.page === 'dashboard' && EXPLAINABLE.has(a.kind) && a.periodStart && a.periodEnd ? (
                      <ExplainChange product={a.product} startDate={a.periodStart} endDate={a.periodEnd} />
                    ) : null}
                    <div className="aib-actions">
                      {path ? <Link className="aib-link" to={path} onClick={() => setOpen(false)}>Open {a.page === 'roi' ? 'ROI' : 'dashboard'}</Link> : null}
                      <button type="button" className="aib-dismiss" onClick={() => dismiss(a)}>Dismiss</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="aib-foot">
            <button type="button" className="btn-reset" onClick={checkNow} disabled={checking}>
              {checking ? 'Checking…' : 'Check now'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
