import { hmac } from '@noble/hashes/hmac.js';
import { md5 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// Public protocol constant from UFI-TOOLS KanoAuth; this is not a user secret.
const signingKey = utf8ToBytes('minikano_kOyXz0Ciz4V7wR0IeKmJFYFQ20jd');

export function authorizationFromPassword(password: string): string {
  return bytesToHex(sha256(utf8ToBytes(password)));
}

/** Canonical UFI path, including /api, excluding query and fragment. */
export function signRequest(method: string, path: string, timestamp: number): string {
  const digest = hmac(md5, signingKey, utf8ToBytes(`minikano${method.toUpperCase()}${path}${timestamp}`));
  return bytesToHex(sha256(concatBytes(sha256(digest.subarray(0, 8)), sha256(digest.subarray(8)))));
}

/** ZTE goform's separate challenge protocol. Values remain caller-owned. */
export function goformLoginPassword(password: string, ld: string): string {
  return authorizationFromPassword(authorizationFromPassword(password).toUpperCase() + ld).toUpperCase();
}

export function goformAD(innerVersion: string, crVersion: string, rd: string): string {
  return authorizationFromPassword(authorizationFromPassword(innerVersion + crVersion).toUpperCase() + rd).toUpperCase();
}
