import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { env } from './env';

// AES-256-GCM token encryption.
// Output format: base64url(iv) + ':' + base64url(ciphertext) + ':' + base64url(authTag)
//
// We derive two subkeys from a single master key via SHA-256 with domain separation,
// so the same env var can be used for both token encryption and HMAC state signing
// without sharing the raw key across two different uses.

const IV_BYTES = 12; // GCM standard

let masterKey: Buffer | null = null;
let cryptoKey: Buffer | null = null;
let stateKey: Buffer | null = null;

function loadMasterKey(): Buffer {
  if (masterKey) return masterKey;

  if (env.TOKEN_ENCRYPTION_KEY) {
    const buf = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');
    if (buf.length !== 32) {
      throw new Error(
        'TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 of openssl rand 32)',
      );
    }
    masterKey = buf;
    return masterKey;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('TOKEN_ENCRYPTION_KEY is required in production');
  }

  // eslint-disable-next-line no-console
  console.warn(
    '⚠ TOKEN_ENCRYPTION_KEY not set — generating an ephemeral dev key. ' +
      'Tokens will be unrecoverable after a restart. Set the env var to persist.',
  );
  masterKey = randomBytes(32);
  return masterKey;
}

function deriveSubkey(label: string): Buffer {
  return createHash('sha256').update(loadMasterKey()).update(label).digest();
}

function getCryptoKey(): Buffer {
  if (!cryptoKey) cryptoKey = deriveSubkey('token-encryption-v1');
  return cryptoKey;
}

export function getStateKey(): Buffer {
  if (!stateKey) stateKey = deriveSubkey('state-signing-v1');
  return stateKey;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getCryptoKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    authTag.toString('base64url'),
  ].join(':');
}

export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }
  const [ivB64, ctB64, tagB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64url');
  const ciphertext = Buffer.from(ctB64, 'base64url');
  const authTag = Buffer.from(tagB64, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', getCryptoKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
