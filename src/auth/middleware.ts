import type { RequestHandler, Response } from 'express';
import type { AppKind } from '../domain/types.ts';
import { forbidden, unauthorized } from '../http/errors.ts';
import type { Session, Sessions } from './session.ts';

/** Rejects requests without a valid `Authorization: Bearer <session>`, optionally from one app only. */
export function requireSession(sessions: Sessions, app?: AppKind): RequestHandler {
  return async (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const session = token ? await sessions.verify(token) : null;
    if (!session) throw unauthorized('session_required', 'Sign in again.');
    if (app && session.app !== app) throw forbidden(`This needs the ${app} app.`);
    res.locals.session = session;
    next();
  };
}

/** The session `requireSession` attached to this request. */
export function sessionOf(res: Response): Session {
  const session = res.locals.session as Session | undefined;
  if (!session) throw unauthorized('session_required', 'Sign in again.');
  return session;
}
