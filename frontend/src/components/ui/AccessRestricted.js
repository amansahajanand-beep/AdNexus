import React from 'react';

/**
 * Inline "Access Restricted" notice shown when a user lacks permission for a
 * resource or action. Reuses the .no-access-* styles from App.css.
 */
export default function AccessRestricted({
  title = 'Access Restricted',
  message = "You don't have permission to access this resource. Please contact your administrator.",
}) {
  return (
    <div className="no-access-wrap">
      <div className="no-access-card">
        <div className="no-access-icon">🔒</div>
        <h2 className="no-access-title">{title}</h2>
        <p className="no-access-msg">{message}</p>
      </div>
    </div>
  );
}
