const crypto = require('crypto');

const PREFIX = 'v1';

function keyBuffer() {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.JWT_SECRET || 'change_this_secret';
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function encryptSecret(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decryptSecret(stored) {
  if (!stored) return null;
  const parts = String(stored).split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('Unrecognized credential ciphertext');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
