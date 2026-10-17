// The shared TinkerAtlas monthly funding goal: the numbers behind the status-bar
// pill, the support panel and the welcome card (ui/funding.ts draws them).
//
// Rust fetches tinkeratlas.com/api/support/current-goal and returns four
// numbers (tinkeratlas.rs `ta_funding_goal`); this side validates them AGAIN,
// because the same shape also comes back out of localStorage, which anything
// can have written. A value that fails validation is treated exactly like no
// value: the feature hides. It never renders a NaN, a negative or a
// server-supplied sentence.
//
// Quiet by design: one fetch shortly after startup, then one every six hours.
// A failed fetch keeps the last good value for up to a week, then hides
// everything. No retries, no toasts.

import { invoke } from "@tauri-apps/api/core";

export interface FundingGoal {
  /** the month's goal, USD, > 0 */
  goal: number;
  /** raised so far this month, USD, >= 0 */
  current: number;
  /** 0..100, held below 100 until the goal is met */
  percentage: number;
  /** day of the month the goal resets on, 1..31 (clamped to short months) */
  reset_day: number;
}

const CACHE_KEY = "sindri.funding.cache";
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const REFRESH_MS = 6 * 60 * 60 * 1000;
const FIRST_FETCH_DELAY_MS = 3000;
/** Mirrors MAX_FUNDING_AMOUNT in tinkeratlas.rs. */
const MAX_AMOUNT = 10_000_000;
/** How many days before the reset the "development pauses" line may show. */
export const WARNING_DAYS = 7;

const amount = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_AMOUNT ? v : null;

/** The validated goal, or null for anything that should not be drawn. */
export function sanitizeFunding(raw: unknown): FundingGoal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const goal = amount(r.goal);
  const current = amount(r.current);
  const pct = amount(r.percentage);
  const day = r.reset_day;
  if (goal === null || goal <= 0 || current === null || pct === null) return null;
  if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const percentage = current >= goal ? 100 : Math.min(Math.round(pct), 99);
  return { goal, current, percentage, reset_day: day };
}

export function isFunded(g: FundingGoal): boolean {
  return g.current >= g.goal;
}

// --- reset date and the stop warning ------------------------------------------

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Whole calendar days from `today` to the next reset. A reset day past the end
 *  of a short month (31 in November) falls on that month's last day, and the
 *  reset day itself counts as the start of the new period, so on that day the
 *  next reset is a month away. */
export function daysUntilReset(resetDay: number, today: Date): number {
  const y = today.getFullYear();
  const m = today.getMonth();
  let target = new Date(y, m, Math.min(resetDay, daysInMonth(y, m)));
  if (today.getDate() >= target.getDate()) {
    target = new Date(y, m + 1, Math.min(resetDay, daysInMonth(y, m + 1)));
  }
  // Counted in UTC calendar days so a daylight-saving change in between can't
  // turn 7 days into 6.98.
  const utc = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((utc(target) - utc(today)) / 86_400_000);
}

/** The "development pauses next month" line: only in the last WARNING_DAYS
 *  days before the reset, and only while the month is not covered. */
export function stopWarningDue(g: FundingGoal, today: Date): boolean {
  return !isFunded(g) && daysUntilReset(g.reset_day, today) <= WARNING_DAYS;
}

// --- cache ----------------------------------------------------------------------

export function readCachedFunding(now = Date.now()): FundingGoal | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: unknown; goal?: unknown };
    const at = parsed?.at;
    // A timestamp from the future is as untrustworthy as a stale one.
    if (typeof at !== "number" || !(now - at >= 0 && now - at < CACHE_MAX_AGE_MS)) return null;
    return sanitizeFunding(parsed.goal);
  } catch {
    return null;
  }
}

function writeCache(goal: FundingGoal, now: number): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: now, goal }));
  } catch {
    // storage full or disabled: the pill just won't show instantly next launch
  }
}

// --- live value -------------------------------------------------------------------

let value: FundingGoal | null = null;
const listeners = new Set<(g: FundingGoal | null) => void>();

export function currentFunding(): FundingGoal | null {
  return value;
}

/** Fires immediately with the current value, then whenever it changes. */
export function onFundingChange(fn: (g: FundingGoal | null) => void): () => void {
  listeners.add(fn);
  fn(value);
  return () => listeners.delete(fn);
}

function setValue(next: FundingGoal | null): void {
  if (JSON.stringify(next) === JSON.stringify(value)) return;
  value = next;
  for (const fn of listeners) fn(value);
}

/** One fetch. Success replaces the value and the cache; anything else falls
 *  back to the cache, which itself goes null after a week. */
export async function refreshFunding(
  fetchGoal: () => Promise<unknown> = () => invoke("ta_funding_goal"),
  now = Date.now(),
): Promise<void> {
  let fresh: FundingGoal | null = null;
  try {
    fresh = sanitizeFunding(await fetchGoal());
  } catch {
    // offline, or an older shell without the command
  }
  if (fresh) {
    writeCache(fresh, now);
    setValue(fresh);
  } else {
    setValue(readCachedFunding(now));
  }
}

let started = false;

/** Show the cached value now, fetch once the UI is up, then every six hours.
 *  Tauri only: the browser build has no native side to ask, and the webview
 *  CSP keeps connect-src on localhost, so it stays hidden there. */
export function startFundingUpdates(): void {
  if (started || !("__TAURI_INTERNALS__" in window)) return;
  started = true;
  setValue(readCachedFunding());
  setTimeout(() => void refreshFunding(), FIRST_FETCH_DELAY_MS);
  setInterval(() => void refreshFunding(), REFRESH_MS);
}
