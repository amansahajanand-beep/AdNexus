import React, { useState } from 'react';

const DISPLAY_LIMIT = 20;

const changeColor = (type) => {
  if (type === 'removed') return '#ef4444';
  if (type === 'added') return '#16a34a';
  return '#2563eb';
};

const changePrefix = (type) => {
  if (type === 'removed') return '−';
  if (type === 'added') return '+';
  return 'ℹ';
};

function ChangeLines({ items, type, title }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const color = changeColor(type);
  const visible = expanded ? items : items.slice(0, DISPLAY_LIMIT);
  const hiddenCount = items.length - visible.length;

  return (
    <div className="perm-change-block">
      <div className="perm-change-block-title" style={{ color }}>
        {title} ({items.length})
      </div>
      <div className="perm-change-lines">
        {visible.map((text) => (
          <div key={`${type}-${text}`} className="perm-change-line" style={{ color }}>
            {changePrefix(type)} {text}
          </div>
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="perm-change-more"
          onClick={() => setExpanded(true)}
        >
          Show {hiddenCount} more…
        </button>
      )}
      {expanded && items.length > DISPLAY_LIMIT && (
        <button
          type="button"
          className="perm-change-more"
          onClick={() => setExpanded(false)}
        >
          Show less
        </button>
      )}
    </div>
  );
}

/** Renders assigned / removed lines for admin permission save dialogs. */
export function PermissionSaveSummary({ username, added = [], removed = [] }) {
  const hasChanges = added.length > 0 || removed.length > 0;
  return (
    <div className="perm-change-summary">
      {username && (
        <div className="perm-change-user">User: <strong>{username}</strong></div>
      )}
      {!hasChanges && (
        <div className="perm-change-empty">No changes made</div>
      )}
      <ChangeLines items={added} type="added" title="Assigned" />
      <ChangeLines items={removed} type="removed" title="Removed" />
    </div>
  );
}

/** Renders mixed change lines (edit user form). */
export function UserEditChangeSummary({ username, changes = [] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? changes : changes.slice(0, DISPLAY_LIMIT);
  const hiddenCount = changes.length - visible.length;

  return (
    <div className="perm-change-summary">
      {username && (
        <div className="perm-change-user">User: <strong>{username}</strong></div>
      )}
      {!changes.length ? (
        <div className="perm-change-empty">No changes made</div>
      ) : (
        <>
          <div className="perm-change-block-title" style={{ color: '#2563eb', marginBottom: 6 }}>
            Changes ({changes.length})
          </div>
          <div className="perm-change-lines">
            {visible.map((c, i) => (
              <div
                key={`${c.type}-${c.text}-${i}`}
                className="perm-change-line"
                style={{ color: changeColor(c.type) }}
              >
                {changePrefix(c.type)} {c.text}
              </div>
            ))}
          </div>
          {hiddenCount > 0 && (
            <button
              type="button"
              className="perm-change-more"
              onClick={() => setExpanded(true)}
            >
              Show {hiddenCount} more…
            </button>
          )}
          {expanded && changes.length > DISPLAY_LIMIT && (
            <button
              type="button"
              className="perm-change-more"
              onClick={() => setExpanded(false)}
            >
              Show less
            </button>
          )}
        </>
      )}
    </div>
  );
}
