import type { RequestHandler, Response } from 'express';
import type { Session } from '../auth/session.ts';
import { logger, logSettings } from '../log/logger.ts';

const log = logger('http');
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

const hasBody = (body: unknown) =>
  body !== undefined && body !== null && (typeof body !== 'object' || Object.keys(body).length > 0);

/**
 * One line per request once it's answered: method, path, status, time taken and
 * who asked, with the (redacted) body and reply underneath when LOG_BODIES allows.
 * Successful reads log at debug level, so `LOG_LEVEL=info` shows only changes and failures.
 */
export function requestLog(): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    let reply: unknown;
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      reply = body;
      return json(body);
    }) as Response['json'];

    res.on('finish', () => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      const status = res.statusCode;
      const read = READS.has(req.method);
      const { bodies } = logSettings();
      const showBodies = bodies === 'all' || (bodies === 'changes' && (!read || status >= 400));
      const session = res.locals.session as Session | undefined;
      const problem = (reply as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      // Query strings can carry addresses and coordinates: only with bodies on.
      const path = bodies === 'off' ? req.path : req.originalUrl;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : read ? 'debug' : 'info';
      log[level](`${req.method} ${path} ${status}`, {
        method: req.method,
        path,
        status,
        ms: elapsed < 10 ? Math.round(elapsed * 10) / 10 : Math.round(elapsed),
        app: session?.app,
        user: session?.userId,
        problem: problem ? `${String(problem.code)}: ${String(problem.message)}` : undefined,
        body: showBodies && hasBody(req.body) ? req.body : undefined,
        reply: showBodies && !problem && reply !== undefined ? reply : undefined,
        error: res.locals.error,
      });
    });
    next();
  };
}
