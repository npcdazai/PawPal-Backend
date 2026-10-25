import { randomInt, timingSafeEqual } from 'node:crypto';

/** How long a development code works. */
export const DEV_CODE_TTL_MS = 10 * 60_000;
/** Wrong codes allowed before the code stops working (a new one has to be sent). */
export const MAX_WRONG_CODES = 5;
/** Code requests allowed per phone number, and per client IP, within `CODE_WINDOW_MS`. */
export const CODES_PER_PHONE = 5;
export const CODES_PER_CLIENT = 20;
export const CODE_WINDOW_MS = 10 * 60_000;

export type CodeCheck =
  /** No code was asked for this number (or it expired): sign in as before codes existed. */
  | { result: 'none' }
  | { result: 'missing' }
  | { result: 'wrong'; triesLeft: number }
  /** Too many wrong codes: refused until a new code is sent or this one would have expired. */
  | { result: 'locked' }
  | { result: 'accepted' };

export interface DevCodes {
  /**
   * Counts one code request against the phone's and the client's windows. Returns the limit it
   * would break (and counts nothing), or null when the request may go ahead.
   */
  admit(phone: string, client: string): 'phone' | 'client' | null;
  /** A fresh 6-digit code for the number, replacing any earlier one. */
  issue(phone: string): { code: string; expiresAt: number };
  /** Checks a typed code against the number's pending code; a right code works once. */
  check(phone: string, code: string | undefined): CodeCheck;
}

interface Pending {
  /** null once locked by wrong tries. */
  code: string | null;
  expiresAt: number;
  wrong: number;
}

/** 100000–999999, so no leading zero gets lost on the way. */
export const randomCode = () => String(randomInt(100_000, 1_000_000));

const same = (typed: string, expected: string) =>
  typed.length === expected.length && timingSafeEqual(Buffer.from(typed), Buffer.from(expected));

/**
 * Development verification codes, kept in memory: the stand-in for an SMS when the server
 * runs with development sign-in. Nothing here is used for Firebase sign-ins.
 */
export function createDevCodes({ now, generate = randomCode }: { now: () => number; generate?: () => string }): DevCodes {
  const pending = new Map<string, Pending>();
  const byPhone = new Map<string, number[]>();
  const byClient = new Map<string, number[]>();
  let sweptAt = 0;

  /** Drops expired codes and idle windows about once a minute, so the maps can't grow without bound. */
  function sweep(at: number) {
    if (at - sweptAt < 60_000) return;
    sweptAt = at;
    for (const [phone, entry] of pending) if (entry.expiresAt <= at) pending.delete(phone);
    for (const windows of [byPhone, byClient]) {
      for (const [key, times] of windows) if (!times.some((time) => time > at - CODE_WINDOW_MS)) windows.delete(key);
    }
  }

  /** The requests still inside the window for one key (stored back trimmed; a key with none left is dropped). */
  function recent(windows: Map<string, number[]>, key: string, at: number) {
    const times = (windows.get(key) ?? []).filter((time) => time > at - CODE_WINDOW_MS);
    if (times.length > 0) windows.set(key, times);
    else windows.delete(key);
    return times;
  }

  function count(windows: Map<string, number[]>, key: string, times: number[], at: number) {
    times.push(at);
    windows.set(key, times);
  }

  return {
    admit(phone, client) {
      const at = now();
      sweep(at);
      // The client's limit first, and nothing is stored for a refused request, so a client
      // over its limit can't make the server remember one new number after another.
      const clientTimes = recent(byClient, client, at);
      if (clientTimes.length >= CODES_PER_CLIENT) return 'client';
      const phoneTimes = recent(byPhone, phone, at);
      if (phoneTimes.length >= CODES_PER_PHONE) return 'phone';
      count(byClient, client, clientTimes, at);
      count(byPhone, phone, phoneTimes, at);
      return null;
    },

    issue(phone) {
      const entry: Pending = { code: generate(), expiresAt: now() + DEV_CODE_TTL_MS, wrong: 0 };
      pending.set(phone, entry);
      return { code: entry.code as string, expiresAt: entry.expiresAt };
    },

    check(phone, code) {
      const entry = pending.get(phone);
      if (!entry || entry.expiresAt <= now()) {
        pending.delete(phone);
        return { result: 'none' };
      }
      if (entry.code === null) return { result: 'locked' };
      if (code === undefined) return { result: 'missing' };
      if (same(code, entry.code)) {
        pending.delete(phone);
        return { result: 'accepted' };
      }
      entry.wrong += 1;
      if (entry.wrong >= MAX_WRONG_CODES) {
        entry.code = null;
        return { result: 'locked' };
      }
      return { result: 'wrong', triesLeft: MAX_WRONG_CODES - entry.wrong };
    },
  };
}
