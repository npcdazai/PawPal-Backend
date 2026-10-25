/** An error with an HTTP status and a stable machine-readable code for the apps. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const unauthorized = (code: string, message: string) => new HttpError(401, code, message);
export const forbidden = (message = 'You can’t do that with this account.') => new HttpError(403, 'forbidden', message);
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found.`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const tooManyRequests = (code: string, message: string) => new HttpError(429, code, message);
export const unavailable = (code: string, message: string) => new HttpError(503, code, message);
