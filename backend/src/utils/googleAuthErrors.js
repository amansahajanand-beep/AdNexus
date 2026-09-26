/**
 * Classify Google OAuth / GAM API auth errors for API responses (no secrets).
 */
function classifyGoogleAuthError(err) {
  const soapBody = typeof err?.response?.data === 'string'
    ? err.response.data
    : (err?.response?.data != null ? JSON.stringify(err.response.data) : '');
  const raw = String(
    err?.response?.data?.error
      || err?.response?.data?.error_description
      || soapBody
      || err?.message
      || err
      || ''
  );
  const lower = raw.toLowerCase();

  if (lower.includes('network_api_access_disabled') || lower.includes('authenticationerror.network_api_access_disabled')) {
    return {
      code: 'NETWORK_API_ACCESS_DISABLED',
      status: 503,
      error:
        'Google Ad Manager API access is disabled for this network. '
        + 'In GAM Admin → Global settings → Network settings, turn on “API access”, '
        + 'then retry. OAuth is fine — this network simply blocks the API.',
      isMock: false,
      authError: true,
      authCode: 'NETWORK_API_ACCESS_DISABLED',
    };
  }

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

  if (lower.includes('authenticationerror') || lower.includes('not_whitelisted_for_api_access')) {
    return {
      code: 'GAM_AUTH_ERROR',
      status: 503,
      error:
        'Google Ad Manager rejected this network’s API request. '
        + 'Confirm the Google user used for OAuth has access to this network and that API access is enabled.',
      isMock: false,
    };
  }

  return null;
}

module.exports = { classifyGoogleAuthError };
