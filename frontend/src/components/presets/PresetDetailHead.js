import React from 'react';
import { summaryForPreset } from '../../utils/reportPresets';

/** Title, summary and Open / Pin / Duplicate / Rename / Delete actions for a preset detail pane. */
export default function PresetDetailHead({
  presetItem,
  openLabel,
  onOpen,
  onPin,
  onRename,
  onDelete,
  onDuplicate,
}) {
  return (
    <div className="presets-roi-detail-head">
      <div>
        <h2 className="presets-roi-detail-title">
          {presetItem.pinned ? <span className="presets-pin-badge" title="Pinned">★</span> : null}
          {presetItem.name}
        </h2>
        <p className="presets-roi-detail-summary">
          {presetItem.summary || summaryForPreset(presetItem.snapshot)}
        </p>
      </div>
      <div className="presets-item-actions">
        <button type="button" className="btn-generate" onClick={onOpen}>{openLabel}</button>
        {onPin ? (
          <button
            type="button"
            className={`btn-reset${presetItem.pinned ? ' presets-pin-active' : ''}`}
            onClick={onPin}
          >
            {presetItem.pinned ? 'Unpin' : 'Pin'}
          </button>
        ) : null}
        {onDuplicate ? <button type="button" className="btn-reset" onClick={onDuplicate}>Duplicate</button> : null}
        {onRename ? <button type="button" className="btn-reset" onClick={onRename}>Rename</button> : null}
        {onDelete ? <button type="button" className="btn-reset" onClick={onDelete}>Delete</button> : null}
      </div>
    </div>
  );
}
