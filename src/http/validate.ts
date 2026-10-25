import { z } from 'zod';
import { badRequest } from './errors.ts';

/** Parses request input, turning the first problem into a 400 the app can show. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw badRequest('invalid_input', `${where}${issue?.message ?? 'Invalid input.'}`);
}

export const latitude = z.number().min(-90).max(90);
export const longitude = z.number().min(-180).max(180);
export const latLng = z.object({ lat: latitude, lng: longitude });
