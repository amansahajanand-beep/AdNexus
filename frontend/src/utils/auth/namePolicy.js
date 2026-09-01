/**
 * Shared rules for user-typed names (usernames, presets, saved filters, labels).
 */

const RESERVED_WORDS = new Set([
  'admin', 'administrator', 'superadmin', 'superuser', 'root', 'system', 'support',
  'moderator', 'mod', 'anonymous', 'anon', 'null', 'undefined', 'api', 'oauth',
  'login', 'logout', 'password', 'token', 'session', 'server', 'database', 'postgres',
  'owner', 'master', 'sudo', 'adnexus',
]);

const BLOCKED_WORDS = new Set([
  'fuck', 'fucking', 'shit', 'asshole', 'bitch', 'bastard', 'cunt', 'whore', 'slut',
  'nigger', 'nigga', 'faggot', 'retard', 'porn', 'xxx',
]);

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;
const SAVED_NAME_RE = /^[\p{L}\p{N}\s._,&'()+\-]+$/u;

function tokenizeName(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function compactAlphaNum(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findDisallowedWord(raw, { reserved = true, blocked = true } = {}) {
  const compact = compactAlphaNum(raw);
  if (reserved && RESERVED_WORDS.has(compact)) return compact;
  if (blocked && BLOCKED_WORDS.has(compact)) return compact;

  const tokens = tokenizeName(raw);
  for (const token of tokens) {
    if (reserved && RESERVED_WORDS.has(token)) return token;
    if (blocked && BLOCKED_WORDS.has(token)) return token;
  }
  return null;
}

function firstError(errors) {
  return { valid: errors.length === 0, errors, error: errors[0] || null };
}

export function validateUsername(username) {
  const errors = [];
  const value = String(username || '').trim();

  if (!value) errors.push('Username is required.');
  else if (value.length < 2) errors.push('Username must be at least 2 characters.');
  else if (value.length > 32) errors.push('Username must be at most 32 characters.');
  else if (!USERNAME_RE.test(value)) {
    errors.push('Username may use letters, numbers, dot, underscore, and hyphen only.');
  } else {
    const bad = findDisallowedWord(value);
    if (bad) errors.push(`Username cannot contain the word "${bad}".`);
  }

  return firstError(errors);
}

export function validateSavedName(name, { maxLength = 40, minLength = 1, label = 'Name' } = {}) {
  const errors = [];
  const value = String(name || '').trim();

  if (!value) errors.push(`${label} is required.`);
  else if (value.length < minLength) {
    errors.push(`${label} must be at least ${minLength} character${minLength === 1 ? '' : 's'}.`);
  } else if (value.length > maxLength) {
    errors.push(`${label} must be ${maxLength} characters or fewer.`);
  } else if (/[<>]/.test(value)) {
    errors.push(`${label} cannot contain < or >.`);
  } else if (!SAVED_NAME_RE.test(value)) {
    errors.push(`${label} may only use letters, numbers, spaces, and - _ . , & + ( ).`);
  } else {
    const bad = findDisallowedWord(value);
    if (bad) errors.push(`${label} cannot contain the word "${bad}".`);
  }

  return firstError(errors);
}

export function assertValidUsername(username) {
  const result = validateUsername(username);
  if (!result.valid) throw new Error(result.error);
  return String(username).trim();
}

export function assertValidSavedName(name, options) {
  const result = validateSavedName(name, options);
  if (!result.valid) throw new Error(result.error);
  return String(name).trim();
}

export const USERNAME_RULES_HINT =
  '2–32 characters · letters, numbers, dot, underscore, hyphen · no reserved or offensive words';

export const SAVED_NAME_RULES_HINT =
  'Letters, numbers, spaces, and - _ . , & + ( ) only · no reserved or offensive words';
