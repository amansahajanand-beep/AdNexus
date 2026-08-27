import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../store/useAuth';
import { usePermissions } from '../../hooks/usePermissions';
import { getSavedFilters, SAVED_FILTERS_PAGES } from '../../utils/savedFilters';
import { encodeReportShare } from '../../utils/reportShare';

export default function CommandPalette() {
  const { user } = useAuth();
  const { canPage } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setQ('');
      }
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  useEffect(() => { setOpen(false); }, [location.pathname]);

  const items = useMemo(() => {
    const list = [];
    if (canPage('dashboard')) {
      list.push({ id: 'dash', label: 'Dashboard', hint: 'Overview', to: '/dashboard' });
      list.push({
        id: 'last7',
        label: 'Last 7 days',
        hint: 'Dashboard · apply',
        to: `/dashboard?${encodeReportShare({ preset: 'last7' })}`,
      });
    }
    if (canPage('reporting')) {
      list.push({ id: 'rep', label: 'Reporting', hint: 'Build a report', to: '/reporting' });
    }
    if (canPage('roi')) {
      list.push({ id: 'roi', label: 'ROI', hint: 'Spend vs earn', to: '/roi' });
    }
    if (canPage('dashboard')) {
      getSavedFilters(SAVED_FILTERS_PAGES.dashboard, user?.id).slice(0, 6).forEach((f) => {
        list.push({
          id: `sd-${f.id}`,
          label: f.name,
          hint: 'Saved · Dashboard',
          to: `/dashboard?view=${encodeURIComponent(f.id)}`,
        });
      });
    }
    if (canPage('reporting')) {
      getSavedFilters(SAVED_FILTERS_PAGES.reporting, user?.id).slice(0, 6).forEach((f) => {
        list.push({
          id: `sr-${f.id}`,
          label: f.name,
          hint: 'Saved · Reporting',
          to: `/reporting?view=${encodeURIComponent(f.id)}`,
        });
      });
    }
    const needle = q.trim().toLowerCase();
    if (!needle) return list.slice(0, 10);
    return list.filter((it) => `${it.label} ${it.hint}`.toLowerCase().includes(needle)).slice(0, 10);
  }, [canPage, user?.id, q]);

  if (!open) return null;

  return (
    <div className="cmdk-backdrop" onClick={() => setOpen(false)} role="presentation">
      <div
        className="cmdk-dialog"
        role="dialog"
        aria-label="Jump to"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Jump to a page, date range, or saved view…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <ul className="cmdk-list">
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                className="cmdk-item"
                onClick={() => {
                  navigate(it.to);
                  setOpen(false);
                }}
              >
                <span>{it.label}</span>
                <span className="cmdk-hint">{it.hint}</span>
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="cmdk-empty">No matches</li>}
        </ul>
        <p className="cmdk-foot">Ctrl/⌘ K to toggle</p>
      </div>
    </div>
  );
}
