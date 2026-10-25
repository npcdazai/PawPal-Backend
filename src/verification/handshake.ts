import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'pawpal-api';
const PURPOSE = 'shift-unlock';

export interface ShiftHandshake {
  issue(partnerId: string, bookingId: string): Promise<{ token: string; expiresAt: number }>;
  verify(token: string, partnerId: string, bookingId: string): Promise<boolean>;
}

/**
 * Proof that this walker's doorstep selfie just matched their enrolled face for
 * this booking. The pickup-OTP step requires it, so a rented account can't
 * start a walk. It can't double as a session token (no `app` claim).
 */
export function createShiftHandshake(secret: Uint8Array, minutes = 20): ShiftHandshake {
  return {
    async issue(partnerId, bookingId) {
      const token = await new SignJWT({ bookingId, purpose: PURPOSE })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(ISSUER)
        .setSubject(partnerId)
        .setIssuedAt()
        .setExpirationTime(`${minutes}m`)
        .sign(secret);
      return { token, expiresAt: Date.now() + minutes * 60_000 };
    },
    async verify(token, partnerId, bookingId) {
      try {
        const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, algorithms: ['HS256'] });
        return payload.purpose === PURPOSE && payload.sub === partnerId && payload.bookingId === bookingId;
      } catch {
        return false;
      }
    },
  };
}
