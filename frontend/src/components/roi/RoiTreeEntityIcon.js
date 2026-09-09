import React, { useState } from 'react';
import { Smartphone, Globe2 } from '../ui/Icon';

/** ISO2 → flag image (flagcdn). */
export function countryFlagUrl(countryCode) {
  const code = String(countryCode || '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return null;
  return `https://flagcdn.com/w40/${code}.png`;
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
        <Globe2 size={14} strokeWidth={1.75} />
      </span>
    );
  }

  if (kind === 'app') {
    return (
      <span className="roi-tree-entity-glyph roi-tree-entity-glyph--app" title="Application" aria-hidden>
        <Smartphone size={14} strokeWidth={1.75} />
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
