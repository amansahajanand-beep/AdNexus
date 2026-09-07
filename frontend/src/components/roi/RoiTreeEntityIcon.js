import React, { useState } from 'react';

/** ISO2 → flag image (flagcdn). */
export function countryFlagUrl(countryCode) {
  const code = String(countryCode || '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return null;
  return `https://flagcdn.com/w40/${code}.png`;
}

function GlobeIcon() {
  return (
    <svg className="roi-tree-entity-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M3.5 12h17M12 3.5c2.5 2.8 3.8 5.6 3.8 8.5S14.5 17.7 12 20.5C9.5 17.7 8.2 14.9 8.2 12S9.5 6.3 12 3.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AppIcon() {
  return (
    <svg className="roi-tree-entity-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden focusable="false">
      <rect x="5" y="2.5" width="14" height="19" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path d="M10 18.5h4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Small icon before country / site / app labels in the ROI tree.
 * kind: 'country' | 'site' | 'app'
 */
export default function RoiTreeEntityIcon({ kind, code, label }) {
  const [flagFailed, setFlagFailed] = useState(false);

  if (kind === 'site') {
    return (
      <span className="roi-tree-entity-glyph roi-tree-entity-glyph--site" title="Site" aria-hidden>
        <GlobeIcon />
      </span>
    );
  }

  if (kind === 'app') {
    return (
      <span className="roi-tree-entity-glyph roi-tree-entity-glyph--app" title="Application" aria-hidden>
        <AppIcon />
      </span>
    );
  }

  const src = !flagFailed ? countryFlagUrl(code) : null;
  if (!src) {
    const letter = String(label || code || '?').replace(/^[^a-zA-Z0-9]+/, '').charAt(0).toUpperCase() || '?';
    return (
      <span className="roi-tree-entity-glyph roi-tree-entity-glyph--country" aria-hidden>
        {letter}
      </span>
    );
  }

  return (
    <img
      className="roi-tree-entity-icon roi-tree-entity-icon--country"
      src={src}
      alt=""
      width={20}
      height={15}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFlagFailed(true)}
    />
  );
}
