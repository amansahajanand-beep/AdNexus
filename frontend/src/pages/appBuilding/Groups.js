import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { marketIntelAPI } from '../../utils/api';
import { useAuth } from '../../store/useAuth';
import PageHeader from '../../components/ui/PageHeader';
import AppIcon from '../../components/ads/AppIcon';
import AppBuildingTabs from './AppBuildingTabs';
import { Skeleton, nf, VIEWER } from './shared';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import '../AdInsights.css';
import '../AdsViewer.css';

const COPY = {
  app: {
    title: 'App Groups',
    subtitle: 'Your own competitor-app categories, by keyword. An app whose name (or advertiser) matches a keyword joins automatically.',
    unit: 'apps', placeholder: 'e.g. Reader, PDF, scanner', empty: 'No app groups yet. Create one to track a category such as “PDF readers”.',
  },
  video: {
    title: 'Video Groups',
    subtitle: 'Group competitor videos by theme. A video joins when its app or advertiser matches a keyword; reused creatives join automatically.',
    unit: 'videos', placeholder: 'e.g. downloader, dating, loan', empty: 'No video groups yet. Create one to follow a theme such as “video downloaders”.',
  },
};

export default function Groups({ kind = 'app' }) {
  const c = COPY[kind];
  const { isAdmin } = useAuth();
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [kw, setKw] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await marketIntelAPI.groups(kind);
      setGroups(r.groups || []);
    } catch (e) {
      logErrorForDebug('Groups', e);
      setError(getUserFacingMessage(e, 'Could not load groups.'));
    }
  }, [kind]);

  useEffect(() => { setGroups(null); load(); }, [load]);

  const add = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await marketIntelAPI.addGroup({ kind, name, keywords: kw });
      setName('');
      setKw('');
      await load();
    } catch (err) {
      logErrorForDebug('Groups.add', err);
      setError(getUserFacingMessage(err, 'Could not save the group.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (g) => {
    if (!window.confirm(`Delete the group “${g.name}”? The apps and ads in it are not affected.`)) return;
    try {
      await marketIntelAPI.deleteGroup(g.id);
      await load();
    } catch (err) {
      logErrorForDebug('Groups.delete', err);
      setError(getUserFacingMessage(err, 'Could not delete the group.'));
    }
  };

  return (
    <div className="ai-page">
      <PageHeader title={c.title} subtitle={c.subtitle} />
      <AppBuildingTabs />
      {error ? <div className="ai-note">{error}</div> : null}

      {isAdmin ? (
        <form className="chart-card op-find" onSubmit={add}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name" aria-label="Group name" maxLength={80} style={{ maxWidth: 240 }} />
          <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder={`Keywords, comma separated — ${c.placeholder}`} aria-label="Keywords" />
          <button type="submit" className="ui-btn ui-btn-primary" disabled={saving || !name.trim() || !kw.trim()}>{saving ? 'Saving…' : 'Create group'}</button>
        </form>
      ) : null}

      {!groups ? <Skeleton /> : !groups.length ? <div className="chart-card ai-kpi-hint">{c.empty}{isAdmin ? '' : ' Ask an admin to set these up.'}</div> : (
        <div className="op-grid">
          {groups.map((g) => (
            <div key={g.id} className="chart-card op-card">
              <div className="op-head">
                <div>
                  <div className="op-word">{g.name}</div>
                  <div className="ai-kpi-hint">{g.keywords.join(' · ')}</div>
                </div>
                {isAdmin ? <button type="button" className="op-btn" onClick={() => remove(g)} aria-label={`Delete ${g.name}`}>Delete</button> : null}
              </div>
              <div className="bp-stats">
                <div><b>{nf.format(g.apps)}</b><span>{c.unit}</span></div>
                <div><b>{nf.format(g.ads)}</b><span>Ads</span></div>
                <div><b>{nf.format(g.live)}</b><span>Live</span></div>
                <div><b>{nf.format(g.new_7d)}</b><span>New 7d</span></div>
              </div>
              <div className="op-apps">
                {g.members.map((m) => (
                  <span key={m.youtube_id || `${m.advertiser_id}|${m.name}`} className="op-app" title={m.name || m.app_name || m.advertiser_name}>
                    <AppIcon src={m.icon || m.app_icon} name={m.name || m.app_name || m.advertiser_name} size={36} />
                  </span>
                ))}
                {!g.members.length ? <span className="ai-kpi-hint">Nothing matches yet — members appear as the collector identifies more apps.</span> : null}
              </div>
              <div className="op-actions">
                {g.keywords.slice(0, 3).map((k) => <Link key={k} className="op-btn" to={`${VIEWER}?q=${encodeURIComponent(k)}`}>Ads: {k}</Link>)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
