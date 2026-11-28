import React, { useState } from 'react';
import Modal from '../ui/Modal';

const WINNER_DAYS = 60; // an ad still running after this long is tagged "Winner"
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/** Competitor ad card: real video thumbnail, app icon + name, and in-dashboard playback. */
export default function CreativeCard({ c }) {
  const [playing, setPlaying] = useState(false);
  const [iconOk, setIconOk] = useState(true);
  const isNew = c.firstShown && Date.now() - new Date(c.firstShown).getTime() < 7 * 86400000;
  const thumb = c.youtubeId ? `https://i.ytimg.com/vi/${c.youtubeId}/hqdefault.jpg` : c.imageUrl;
  const canPlay = Boolean(c.youtubeId);
  const title = c.appName || c.advertiser || c.advertiserId;

  const media = (
    <>
      {thumb ? <img src={thumb} alt={title} loading="lazy" /> : <span className="av-play">{c.format === 'video' ? '▶' : '▤'}</span>}
      {canPlay ? <span className="av-playbtn" aria-hidden>▶</span> : null}
      <div className="av-tags">
        <span className={`ab-fmt ab-fmt--${c.format || 'text'}`}>{c.format || 'ad'}</span>
        {c.daysShown >= WINNER_DAYS ? <span className="av-tag av-tag--winner">Winner</span> : null}
        {isNew ? <span className="av-tag av-tag--new">New</span> : null}
      </div>
      <span className="av-days">{c.daysShown}d</span>
    </>
  );

  return (
    <div className="av-card">
      {canPlay ? (
        <button type="button" className="av-media av-media--btn" onClick={() => setPlaying(true)} aria-label={`Play ${title}`}>{media}</button>
      ) : (
        <a className="av-media" href={c.link || undefined} target="_blank" rel="noreferrer" title="Open in Google Ads Transparency Center">{media}</a>
      )}
      <div className="av-body">
        <div className="av-appline">
          {c.appIcon && iconOk ? (
            <img className="av-icon" src={c.appIcon} alt="" loading="lazy" onError={() => setIconOk(false)} />
          ) : (
            <span className="av-icon av-icon--ph" aria-hidden>{(title || '?').charAt(0).toUpperCase()}</span>
          )}
          <div className="av-appmeta">
            <div className="av-adv" title={title}>{title}</div>
            {c.appName && c.advertiser ? <div className="av-sub" title={c.advertiser}>{c.advertiser}</div> : c.domain ? <div className="av-sub">{c.domain}</div> : null}
          </div>
        </div>
        <div className="av-live">
          <b>{c.active ? '● Live' : '○ Stopped'}</b> · {fmtDate(c.firstShown)} → {c.active ? 'now' : fmtDate(c.lastShown)}
        </div>
      </div>

      {canPlay ? (
        <Modal open={playing} title={title} onClose={() => setPlaying(false)} width={760}>
          <div className="av-player">
            <iframe
              title={title}
              src={`https://www.youtube-nocookie.com/embed/${c.youtubeId}?autoplay=1&rel=0`}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          </div>
          <div className="av-player-meta">
            {c.advertiser ? <span>{c.advertiser}</span> : null}
            <a href={`https://www.youtube.com/watch?v=${c.youtubeId}`} target="_blank" rel="noreferrer">Open on YouTube</a>
            {c.link ? <a href={c.link} target="_blank" rel="noreferrer">Transparency Center</a> : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
