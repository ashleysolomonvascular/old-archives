// Fingerprint unlock: WebAuthn platform authenticator + PRF extension.
//
// The authenticator's PRF output (a secret that only exists after a successful fingerprint/PIN check)
// is run through HKDF to give an AES-GCM key that wraps the vault key. The vault key itself is never
// stored in the clear; if PRF isn't supported we refuse to enrol and the master password stays the
// only way in. No server is involved, so WebAuthn challenges are local (we only want the PRF secret).
import { randomBytes, encryptBytes, decryptBytes, wipe, DecryptError, b64 } from './crypto.js';
import { dbGet, dbSet, dbDel } from './db.js';

export const MASTER_MAX_AGE_DAYS = 30; // master password needed this often
export const MASTER_MAX_AGE_MS = MASTER_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const enc = new TextEncoder();
const AAD = (credId) => `oa:bio:v1|${b64(credId)}`;

export class BioError extends Error {
  constructor(msg, code) {
    super(msg);
    this.name = 'BioError';
    this.code = code; // 'unsupported' | 'cancelled' | 'failed'
  }
}

export function bioSupported() {
  return typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials;
}

export async function isEnrolled() {
  return !!(await dbGet('bio'));
}

/** True when the master password must be used (no enrolment, or last entry more than 30 days ago). */
export function masterRequired(lastMasterMs, now = Date.now()) {
  return !lastMasterMs || now - lastMasterMs > MASTER_MAX_AGE_MS;
}

async function wrapKeyFromPrf(prfBytes) {
  const base = await crypto.subtle.importKey('raw', prfBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('oa:bio:v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

function toBytes(buf) {
  return new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

async function getPrf(creds, credId, prfSalt, rpId) {
  let cred;
  try {
    cred = await creds.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId,
        allowCredentials: [{ type: 'public-key', id: credId }],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
  } catch (e) {
    throw new BioError('Fingerprint was cancelled or failed', e?.name === 'NotAllowedError' ? 'cancelled' : 'failed');
  }
  const first = cred?.getClientExtensionResults?.()?.prf?.results?.first;
  if (!first) throw new BioError('This device did not return a fingerprint key', 'unsupported');
  return toBytes(first);
}

/** Register a passkey and wrap `vaultRaw` under its PRF-derived key. Throws BioError. */
export async function enroll(vaultRaw, { creds = navigator.credentials, rpId = location.hostname } = {}) {
  let created;
  try {
    created = await creds.create({
      publicKey: {
        rp: { id: rpId, name: 'Old archives' },
        user: { id: randomBytes(16), name: 'archive', displayName: 'Old archives' },
        challenge: randomBytes(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required', requireResidentKey: true },
        timeout: 60000,
        extensions: { prf: {} },
      },
    });
  } catch (e) {
    throw new BioError('Fingerprint setup was cancelled or failed', e?.name === 'NotAllowedError' ? 'cancelled' : 'failed');
  }
  const credId = toBytes(created.rawId);
  const prfSalt = randomBytes(32);
  // Some browsers don't report prf.enabled at creation even when it works, so the real test is whether
  // a second touch returns a PRF secret. If not, nothing is stored and the master password stays in use.
  const flag = created?.getClientExtensionResults?.()?.prf;
  let prf;
  try {
    prf = await getPrf(creds, credId, prfSalt, rpId);
  } catch (e) {
    if (e.code === 'unsupported') {
      throw new BioError(`This phone or browser does not support fingerprint unlock for stored keys (PRF ${flag?.enabled === true ? 'enabled but no secret returned' : 'not reported'}). Use your master password.`, 'unsupported');
    }
    throw e;
  }
  try {
    const wk = await wrapKeyFromPrf(prf);
    const wrapped = await encryptBytes(wk, vaultRaw, AAD(credId));
    await dbSet('bio', { v: 1, credId, prfSalt, wrapped, created: Date.now() });
  } finally {
    wipe(prf);
  }
}

/** Prompt for fingerprint and return the unwrapped vault key (caller owns/wipes it). */
export async function unlockKey({ creds = navigator.credentials, rpId = location.hostname } = {}) {
  const rec = await dbGet('bio');
  if (!rec) throw new BioError('Fingerprint unlock is not set up', 'unsupported');
  const prf = await getPrf(creds, rec.credId, rec.prfSalt, rpId);
  try {
    const wk = await wrapKeyFromPrf(prf);
    return await decryptBytes(wk, rec.wrapped, AAD(rec.credId));
  } catch (e) {
    if (e instanceof DecryptError) throw new BioError('Fingerprint key did not match. Use your master password.', 'failed');
    throw e;
  } finally {
    wipe(prf);
  }
}

export async function disable() {
  await dbDel('bio');
}

