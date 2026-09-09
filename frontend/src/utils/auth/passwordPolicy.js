const SPECIAL_RE = /[!@#$%^&*]/;
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', 'qwerty123',
  'admin123', 'letmein', 'welcome1', 'changeme', 'iloveyou', 'monkey123',
]);

export function validatePassword(password, { username = '' } = {}) {
  const errors = [];
  const p = String(password || '');

  if (p.length < 8) errors.push('Password must be at least 8 characters.');
  if (p.length > 32) errors.push('Password must be at most 32 characters.');
  if (!/[A-Z]/.test(p)) errors.push('Include at least one uppercase letter (A–Z).');
  if (!/[a-z]/.test(p)) errors.push('Include at least one lowercase letter (a–z).');
  if (!/[0-9]/.test(p)) errors.push('Include at least one number (0–9).');
  if (!SPECIAL_RE.test(p)) errors.push('Include at least one special character (!@#$%^&*).');
  if (/(.)\1{2,}/.test(p)) errors.push('Avoid repeated characters (e.g. aaa).');
  if (COMMON_PASSWORDS.has(p.toLowerCase())) errors.push('This password is too common.');
  const u = username.trim().toLowerCase();
  if (u && p.toLowerCase().includes(u)) errors.push('Password must not contain the username.');

  return { valid: errors.length === 0, errors };
}

export const PASSWORD_RULES_HINT =
  'Min 8, max 32 · 1 uppercase · 1 lowercase · 1 number · 1 special (!@#$%^&*)';

/** Generate a policy-compliant temporary password for domain-user reset/view. */
export function generatePassword(username = '') {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%^&*';
  const all = upper + lower + digits + special;
  const pick = (chars) => chars[Math.floor(Math.random() * chars.length)];

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const parts = [pick(upper), pick(lower), pick(digits), pick(special)];
    while (parts.length < 12) parts.push(pick(all));
    for (let i = parts.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [parts[i], parts[j]] = [parts[j], parts[i]];
    }
    const password = parts.join('');
    if (validatePassword(password, { username }).valid) return password;
  }
  return `Aa1!${Date.now().toString(36).slice(-6)}Xx`;
}
