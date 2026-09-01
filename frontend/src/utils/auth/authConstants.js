/** Shared auth storage keys — keep dependency-free to avoid circular imports. */
export const TOKEN_KEY = 'gam_token';
export const SESSION_SUPERSEDED_KEY = 'gam_session_superseded';
/** Cross-tab hint: another tab started a manual sign-out (short-lived). */
export const INTENTIONAL_LOGOUT_KEY = 'gam_intentional_logout';
/** Per-tab flag: cleared only on next successful login. */
export const INTENTIONAL_LOGOUT_TAB_KEY = 'gam_intentional_logout_tab';
