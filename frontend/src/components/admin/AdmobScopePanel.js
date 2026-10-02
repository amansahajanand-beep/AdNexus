import React from 'react';
import PublisherScopePanel, { EMPTY_ADMOB_SCOPE, admobScopeFromUser } from './PublisherScopePanel';

export { EMPTY_ADMOB_SCOPE, admobScopeFromUser };

/** Admin → user form: AdMob publishers / apps / ad units, filters, metrics and reports for a domain user. */
export default function AdmobScopePanel({ value = EMPTY_ADMOB_SCOPE, onChange }) {
  return <PublisherScopePanel product="admob" value={value} onChange={onChange} />;
}
