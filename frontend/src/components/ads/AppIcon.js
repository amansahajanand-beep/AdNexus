import React, { useState } from 'react';

/** App icon with a lettered placeholder when there is no icon yet (or it fails to load). */
export default function AppIcon({ src, name, size = 34 }) {
  const [ok, setOk] = useState(true);
  const style = { width: size, height: size, borderRadius: Math.round(size * 0.26), fontSize: Math.round(size * 0.42) };
  if (src && ok) return <img className="av-icon" style={style} src={src} alt="" loading="lazy" onError={() => setOk(false)} />;
  return <span className="av-icon av-icon--ph" style={style} aria-hidden>{String(name || '?').trim().charAt(0).toUpperCase() || '?'}</span>;
}
