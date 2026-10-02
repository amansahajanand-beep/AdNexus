import React from 'react';
import PublisherScopePanel, { EMPTY_ADSENSE_SCOPE, adsenseScopeFromUser } from './PublisherScopePanel';

export { EMPTY_ADSENSE_SCOPE, adsenseScopeFromUser };

/** Admin → user form: AdSense publishers / sites, filters, metrics and reports for a domain user. */
export default function AdsenseScopePanel({ value = EMPTY_ADSENSE_SCOPE, onChange }) {
  return <PublisherScopePanel product="adsense" value={value} onChange={onChange} />;
}
