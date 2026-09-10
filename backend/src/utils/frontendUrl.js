/**
 * Base URL the OAuth callbacks redirect back to.
 *
 * FRONTEND_URL without a scheme makes res.redirect() emit a relative Location,
 * which the browser resolves against /auth/... instead of the dashboard host.
 */
function frontendBaseUrl() {
  const raw = String(process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return 'http://localhost:3000';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

module.exports = { frontendBaseUrl };
