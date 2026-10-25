import { SignJWT, jwtVerify } from 'jose';
import type { AppKind } from '../domain/types.ts';

const ISSUER = 'pawpal-api';

export interface Session {
  userId: string;
  app: AppKind;
}

export interface Sessions {
  issue(session: Session): Promise<string>;
  /** The session, or null for a missing, forged or expired token. */
  verify(token: string): Promise<Session | null>;
}

/** The API's own bearer tokens, handed out once a phone number has been verified. */
export function createSessions(secret: Uint8Array, days: number): Sessions {
  return {
    issue: ({ userId, app }) =>
      new SignJWT({ app })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(ISSUER)
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime(`${days}d`)
        .sign(secret),
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, algorithms: ['HS256'] });
        const app = payload.app;
        if (!payload.sub || (app !== 'customer' && app !== 'partner')) return null;
        return { userId: payload.sub, app };
      } catch {
        return null;
      }
    },
  };
}
