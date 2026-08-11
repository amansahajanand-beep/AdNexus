import React from 'react';
import { NO_DOMAINS_MSG, NO_DOMAINS_TITLE } from '../../utils/permissions';

/**
 * Shown when a domain user has no admin-assigned domains (filter/report inventory).
 */
export default function NoDomainsAssignedNote({ title = NO_DOMAINS_TITLE, message = NO_DOMAINS_MSG }) {
  return (
    <div className="no-domains-note" role="status">
      <span className="no-domains-note-icon" aria-hidden>🌐</span>
      <div>
        <p className="no-domains-note-title">{title}</p>
        <p className="no-domains-note-msg">{message}</p>
      </div>
    </div>
  );
}
