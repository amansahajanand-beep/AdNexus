/**
 * Classify Google OAuth / token errors for API responses (no secrets).
 */
function classifyGoogleAuthError(err) {
  const raw = String(
    err?.response?.data?.error
      || err?.response?.data?.error_description
      || err?.message
      || err
      || ''
  );
  const lower = raw.toLowerCase();

  if (lower.includes('invalid_client')) {
    return {
      code: 'INVALID_GOOGLE_CLIENT',
      status: 503,
      error:
        'Google OAuth rejected this app’s client ID/secret (invalid_client). '
        + 'Update credentials in Admin → Client settings, or set SYNC_GAM_CREDS_FROM_ENV=true '
        + 'after fixing production .env and restart once. Client ID existing is not enough — '
        + 'secret and refresh token must match the same Google Cloud OAuth client.',
      isMock: false,
    };
  }

  if (lower.includes('invalid_grant') || lower.includes('unauthorized_client')) {
    return {
      code: 'INVALID_GOOGLE_REFRESH_TOKEN',
      status: 503,
      error:
        'Google rejected the refresh token. Re-connect Google OAuth (Admin → Client settings) '
        + 'to issue a new refresh token for this client ID.',
      isMock: false,
    };
  }

  return null;
}

module.exports = { classifyGoogleAuthError };
