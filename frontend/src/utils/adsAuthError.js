/** Detect Google Ads OAuth / invalid_grant style sync failures. */
export function isAdsAuthError(message) {
  return /invalid_grant|refresh token|reconnect|oauth disconnected|unauthorized_client|oauth scope|authentication|authorization/i
    .test(String(message || ''));
}

export function accountNeedsReconnect(account) {
  if (!account) return false;
  if (!account.hasRefreshToken) return true;
  return isAdsAuthError(account.lastSyncError);
}

export const ADS_RECONNECT_INSTRUCTIONS = [
  'If sync fails with invalid_grant (often after 1–2 weeks), the Google refresh token was revoked or expired.',
  'Click Reconnect on the manager (MCC) account — partner/child accounts use the MCC login.',
  'Do not remove the account to fix this: Disconnect OAuth only clears the login and keeps synced spend history.',
  'After reconnecting, click Sync spend so ROI picks up fresh data.',
];
