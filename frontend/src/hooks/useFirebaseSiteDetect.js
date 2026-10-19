import { useEffect, useRef, useState } from 'react';
import { adsAPI } from '../utils/api';

/**
 * Background subdomain detection for the App IDs the user explicitly picked (ROI page). Pass [] when nothing specific
 * is picked (e.g. "All selected") and nothing is detected.
 * For each app package the backend finds its Firebase project and reads the subdomain from the newest app version's
 * Remote Config JSON. Detected subdomains are handed to onAddSites; when the apps that brought them in are deselected
 * they are handed to onRemoveSites. Nothing is shown while it runs and failures are silent (the Subdomains filter stays
 * fully manual).
 * Returns { connected, linked, missing } for an optional one-line hint.
 */
export default function useFirebaseSiteDetect(appKeys, onAddSites, onRemoveSites, networkIds = []) {
  const [state, setState] = useState({ connected: false, linked: 0, missing: 0, done: false, loading: false, notInGam: [] });
  const added = useRef(new Set());
  const onAdd = useRef(onAddSites);
  onAdd.current = onAddSites;
  const onRemove = useRef(onRemoveSites);
  onRemove.current = onRemoveSites;
  const key = (appKeys || []).join('|');
  // A domain user with several networks: an app's Firebase link can sit in any of them, so each is asked.
  const netKey = (networkIds || []).join(',');

  useEffect(() => {
    if (!key) {
      // Nothing specific selected any more: take back what detection added.
      if (added.current.size) {
        onRemove.current?.([...added.current]);
        added.current.clear();
      }
      setState({ connected: false, linked: 0, missing: 0, done: false, loading: false, notInGam: [] });
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setState((st) => ({ ...st, loading: true }));
      try {
        const ids = netKey ? netKey.split(',') : [];
        const apps = key.split('|');
        const replies = ids.length > 1
          ? await Promise.all(ids.map((id) => adsAPI.resolveFirebaseSites(apps, false, id).catch(() => null)))
          : [await adsAPI.resolveFirebaseSites(apps)];
        if (cancelled) return;
        const bodies = replies.filter(Boolean).map((res) => (res && res.data !== undefined ? res.data : res));
        if (!bodies.length) throw new Error('Firebase lookup failed');
        // Same app in several networks: join their sites.
        const byApp = new Map();
        bodies.forEach((b) => (b.results || []).forEach((r) => {
          const cur = byApp.get(r.app) || { app: r.app, manualSites: [], autoSites: [], notInGam: [] };
          cur.notInGam = [...new Set([...(cur.notInGam || []), ...(r.notInGam || [])])];
          cur.manualSites = [...new Set([...cur.manualSites, ...(r.manualSites || [])])];
          cur.autoSites = [...new Set([...cur.autoSites, ...(r.autoSites || [])])];
          byApp.set(r.app, cur);
        }));
        const results = [...byApp.values()];
        // Subdomains in an app's quiz link lists that are in no GAM network (red in the filter area). With several
        // networks a host counts as missing only when none of them has it.
        const present = new Set(results.flatMap((r) => [...r.manualSites, ...r.autoSites]));
        const missingByHost = new Map();
        results.forEach((r) => (r.notInGam || []).forEach((h) => {
          if (present.has(h)) return;
          missingByHost.set(h, [...new Set([...(missingByHost.get(h) || []), r.app])]);
        }));
        const notInGam = [...missingByHost.entries()].map(([host, apps]) => ({ host, apps })).sort((a, b) => a.host.localeCompare(b.host));
        const body = { connected: bodies.some((b) => b.connected !== false) };
        const sitesOf = (r) => [...r.manualSites, ...r.autoSites];
        const wanted = new Set(results.flatMap(sitesOf));
        const fresh = [...wanted].filter((s) => !added.current.has(s));
        const stale = [...added.current].filter((s) => !wanted.has(s));
        if (fresh.length) {
          fresh.forEach((s) => added.current.add(s));
          onAdd.current?.(fresh);
        }
        if (stale.length) {
          stale.forEach((s) => added.current.delete(s));
          onRemove.current?.(stale);
        }
        setState({
          connected: body.connected !== false,
          linked: results.filter((r) => sitesOf(r).length).length,
          missing: results.filter((r) => !sitesOf(r).length).length,
          done: true,
          loading: false,
          notInGam,
        });
      } catch (_) {
        if (!cancelled) setState((s) => ({ ...s, done: true, loading: false }));
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, netKey]);

  return state;
}
