import { createHash } from 'node:crypto';
import type { App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FirebasePhoneNumberVerificationError, getPhoneNumberVerification } from 'firebase-admin/phone-number-verification';
import { unauthorized, unavailable } from '../http/errors.ts';

/**
 * How the app proved the number:
 * - `pnv`: Firebase Phone Number Verification (carrier check, no SMS). Android only, and only in
 *   the countries Firebase lists; India isn't one yet.
 * - `sms`: Firebase Auth phone sign-in (SMS OTP); the app sends the signed-in user's ID token.
 */
export type PhoneMethod = 'pnv' | 'sms';

export interface VerifiedPhone {
  /** E.164, e.g. "+919876543210". */
  phone: string;
  /** Unique per token, for one-time use; null for development logins. */
  tokenId: string | null;
  /** When the phone token itself expires (ms). */
  expiresAt: number;
}

export type PhoneVerifier = (token: string, method: PhoneMethod) => Promise<VerifiedPhone>;

const DEV_PREFIX = 'dev:';
export const E164 = /^\+[1-9]\d{7,14}$/;

/** "dev:+91…": a development login rather than a Firebase token. */
export const isDevToken = (token: string) => token.startsWith(DEV_PREFIX);

/**
 * Turns the token the app got from Firebase into a verified phone number.
 * With `devLogin`, "dev:+919876543210" is accepted as well, for web builds and
 * emulators where neither carrier checks nor SMS can run.
 */
export function createPhoneVerifier({ firebaseApp, devLogin }: { firebaseApp: App | null; devLogin: boolean }): PhoneVerifier {
  const pnv = firebaseApp ? getPhoneNumberVerification(firebaseApp) : null;
  const auth = firebaseApp ? getAuth(firebaseApp) : null;

  /** Firebase Auth ID token from a completed SMS sign-in. */
  async function verifySms(idToken: string): Promise<VerifiedPhone> {
    if (!auth) {
      throw unavailable('phone_verification_unconfigured', 'Phone verification needs Firebase credentials on the server.');
    }
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken, true);
    } catch {
      throw unauthorized('invalid_phone_token', 'We couldn’t verify that phone number. Sign in again.');
    }
    const phone = decoded.phone_number;
    if (decoded.firebase.sign_in_provider !== 'phone' || !phone || !E164.test(phone)) {
      throw unauthorized('invalid_phone_token', 'That sign-in didn’t verify a phone number.');
    }
    // ID tokens are bound to the Firebase session and expire within the hour, so reuse is allowed.
    return { phone, tokenId: null, expiresAt: decoded.exp * 1000 };
  }

  return async (token, method) => {
    if (isDevToken(token)) {
      if (!devLogin) throw unauthorized('invalid_phone_token', 'Development logins are turned off.');
      const phone = token.slice(DEV_PREFIX.length).replace(/[\s()-]/g, '');
      if (!E164.test(phone)) throw unauthorized('invalid_phone_token', 'Use dev:+<country code><number>.');
      return { phone, tokenId: null, expiresAt: Date.now() };
    }

    if (method === 'sms') return verifySms(token);
    if (!pnv) {
      throw unavailable('phone_verification_unconfigured', 'Phone verification needs Firebase credentials on the server.');
    }
    try {
      const decoded = await pnv.verifyToken(token);
      if (!E164.test(decoded.phoneNumber)) throw unauthorized('invalid_phone_token', 'The token has no usable phone number.');
      return {
        phone: decoded.phoneNumber,
        tokenId: decoded.jti || createHash('sha256').update(token).digest('hex'),
        expiresAt: decoded.exp * 1000,
      };
    } catch (error) {
      if (error instanceof FirebasePhoneNumberVerificationError) {
        const expired = error.code.endsWith('expired-token');
        throw unauthorized(
          expired ? 'phone_token_expired' : 'invalid_phone_token',
          expired ? 'That verification has expired. Verify your number again.' : 'We couldn’t verify that phone number.'
        );
      }
      throw error;
    }
  };
}
