// The funding pill, its panel and the welcome card, rendered through the real
// components against the fake DOM, fed through the same path the app uses
// (refreshFunding → the validated value → every listener). Assertions are over
// what a user would see or a screen reader would announce: the pill's text and
// visibility, the progressbar's ARIA values, the button order and where each
// button goes, whether the stop warning is on screen.
import { describe, it, expect, vi, beforeEach } from "vitest";
import capabilitiesSrc from "../../src-tauri/capabilities/default.json?raw";
import { FakeEl, byClass, installFakeDocument, installFakeEvents } from "./fakeDom.testkit";

const stub = vi.hoisted(() => ({
  opened: [] as string[],
  invoked: [] as string[],
  answer: null as unknown,
}));
vi.mock("./help", () => ({
  openHelp: (url: string) => {
    stub.opened.push(url);
    return Promise.resolve();
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    stub.invoked.push(cmd);
    return Promise.resolve(cmd === "ta_funding_goal" ? stub.answer : null);
  },
}));

installFakeEvents();
installFakeDocument();
const ls = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => void ls.set(k, v),
  removeItem: (k: string) => void ls.delete(k),
};

import { FundingSupport, SUPPORT_LINKS, mountFundingCard, pillHidden, renderFundingBody } from "./funding";
import { WelcomeScreen } from "./welcome";
import {
  CACHE_MAX_AGE_MS,
  REFRESH_MS,
  currentFunding,
  daysUntilReset,
  refreshFunding,
  sanitizeFunding,
  type FundingGoal,
} from "../tinkeratlas/funding";

/** What ta_funding_goal returned for the live endpoint on 2026-10-17. */
const LIVE = { goal: 335, current: 147, percentage: 44, reset_day: 20 };
const FUNDED = { goal: 335, current: 401.5, percentage: 100, reset_day: 20 };
/** Outside the warning window for reset_day 20. */
const QUIET_DAY = new Date(2026, 9, 2);

const body = () => document.body as unknown as FakeEl;
const one = (root: FakeEl, cls: string) => {
  const hits = byClass(root, cls);
  expect(hits, `exactly one .${cls}`).toHaveLength(1);
  return hits[0]!;
};
const text = (el: FakeEl): string => el.textContent + el.children.map(text).join("");
const pillLabel = (s: FundingSupport) => text(s.pill as unknown as FakeEl);
/** The open panel; the assertion is the null check, so callers get a FakeEl. */
const panelOf = (): FakeEl => {
  const panel = byClass(body(), "funding-panel")[0];
  expect(panel, "the funding panel is open").toBeDefined();
  return panel!;
};
const panelOpen = () => byClass(body(), "funding-panel").length > 0;
const buttons = (root: FakeEl) => byClass(root, "funding-links")[0]?.children ?? [];

// Every instance a test makes, so the next test starts with no panel open and
// no Escape listener from an earlier one standing in front of its own.
const made: FundingSupport[] = [];
function support(): FundingSupport {
  const s = new FundingSupport();
  made.push(s);
  return s;
}

async function feed(answer: unknown, now = Date.now()) {
  await refreshFunding(() => Promise.resolve(answer), now);
}

beforeEach(async () => {
  for (const s of made.splice(0)) s.closePanel();
  // A fresh window per test: Node's EventTarget does not drop a listener added
  // with capture=true when it is removed the same way, so a closed welcome
  // screen's Escape handler would otherwise still swallow the next Escape.
  (globalThis as unknown as { window: EventTarget }).window = new EventTarget();
  ls.clear();
  stub.opened.length = 0;
  body().children.length = 0;
  await feed(null); // no answer and no cache: back to "nothing to show"
  expect(currentFunding()).toBeNull();
});

describe("pill, panel and welcome card from the live payload", () => {
  it("shows the pill with the percentage once data arrives, and not before", async () => {
    const s = support();
    expect(s.pill.hidden).toBe(true);
    await feed(LIVE);
    expect(s.pill.hidden).toBe(false);
    expect(pillLabel(s)).toBe("Funding 44%");
    expect(s.pill.getAttribute("aria-haspopup")).toBe("dialog");
    expect(s.pill.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a panel with a real progressbar, the amounts, and the three buttons in order", async () => {
    await feed(LIVE);
    const s = support();
    (s.pill as unknown as FakeEl).dispatch("click");
    const panel = panelOf();
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(s.pill.getAttribute("aria-expanded")).toBe("true");
    expect(text(one(panel, "funding-title"))).toBe("Keep SindriCAD in development");

    const bar = one(panel, "funding-bar");
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuenow")).toBe("44");
    expect(bar.getAttribute("aria-label")).toBe("Funding this month");
    expect(bar.getAttribute("aria-valuetext")).toBe("$147 of $335 this month");
    expect(one(bar, "funding-bar-fill").style.width).toBe("44%");
    expect(text(one(panel, "funding-amounts"))).toBe("$147 of $335 this month");
    expect(text(one(panel, "funding-status"))).toBe("$188 still needed this month.");

    const btns = buttons(panel);
    expect(btns.map((b) => b.textContent)).toEqual(["PayPal", "Ko-fi", "TinkerAtlas"]);
    expect(btns.map((b) => b.tagName)).toEqual(["button", "button", "button"]);
    expect(btns.map((b) => b.classList.contains("choice-primary"))).toEqual([true, false, false]);
    for (const b of btns) b.dispatch("click");
    expect(stub.opened).toEqual([
      "https://paypal.me/makerviking",
      "https://ko-fi.com/tinkeratlas",
      "https://tinkeratlas.com/pricing",
    ]);
  });

  it("never shows the server's own status sentence", async () => {
    await feed({ ...LIVE, status_message: "<img src=x onerror=alert(1)> $188 still needed" });
    const host = new FakeEl("div");
    renderFundingBody(host as unknown as HTMLElement, currentFunding(), QUIET_DAY);
    expect(text(host)).not.toContain("onerror");
    expect(text(host)).not.toContain("running costs");
  });

  it("fills the welcome screen's card live, and empties it when the data goes", async () => {
    const welcome = new WelcomeScreen({
      onNew: () => {},
      onOpen: () => {},
      onOpenPath: async () => "ok",
      onSignIn: () => {},
      onSignOut: () => {},
    });
    welcome.open();
    const card = one(body(), "welcome-funding");
    expect(card.hidden).toBe(true);
    expect(card.children).toHaveLength(0);

    await feed(LIVE);
    expect(card.hidden).toBe(false);
    expect(text(one(card, "funding-title"))).toBe("Keep SindriCAD in development");
    expect(one(card, "funding-bar").getAttribute("aria-valuenow")).toBe("44");
    expect(buttons(card).map((b) => b.textContent)).toEqual(["PayPal", "Ko-fi", "TinkerAtlas"]);
    // the card has no "hide" link: that belongs to the pill's own panel
    expect(byClass(card, "funding-hide")).toHaveLength(0);

    ls.clear();
    await feed({ goal: Number.NaN });
    expect(card.hidden).toBe(true);
    expect(card.children).toHaveLength(0);
    welcome.close();
  });
});

describe("funded month", () => {
  it("says thank you, fills the bar, and keeps the buttons", async () => {
    const s = support();
    await feed(FUNDED);
    expect(pillLabel(s)).toBe("Funded");
    s.openPanel();
    const panel = panelOf();
    const bar = one(panel, "funding-bar");
    expect(bar.classList.contains("funded")).toBe(true);
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(text(one(panel, "funding-status"))).toBe("This month is covered. Thank you!");
    expect(buttons(panel)).toHaveLength(3);
  });

  it("is never 100% short of the goal", async () => {
    const s = support();
    await feed({ goal: 335, current: 334.6, percentage: 100, reset_day: 20 });
    expect(pillLabel(s)).toBe("Funding 99%");
    s.openPanel();
    expect(text(one(panelOf(), "funding-amounts"))).toBe("$334 of $335 this month");
    expect(text(one(panelOf(), "funding-status"))).toBe("$1 still needed this month.");
  });
});

describe("the stop warning shows only in the last 7 days before the reset, and only unfunded", () => {
  const warned = (goal: FundingGoal, today: Date) => {
    const host = new FakeEl("div");
    renderFundingBody(host as unknown as HTMLElement, goal, today);
    const w = byClass(host, "funding-warning");
    if (w.length) {
      expect(text(w[0]!)).toBe("If this month isn't covered, SindriCAD development pauses next month.");
    }
    return w.length === 1;
  };
  const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

  // [reset_day, today, days until the reset, warning shown]
  const cases: [number, Date, number, boolean][] = [
    [20, d(2026, 10, 12), 8, false],
    [20, d(2026, 10, 13), 7, true],
    [20, d(2026, 10, 17), 3, true],
    [20, d(2026, 10, 19), 1, true],
    [20, d(2026, 10, 20), 31, false], // the reset day starts the new month
    [20, d(2026, 10, 21), 30, false],
    // reset_day 31 in a 30-day month lands on the 30th
    [31, d(2026, 11, 22), 8, false],
    [31, d(2026, 11, 23), 7, true],
    [31, d(2026, 11, 29), 1, true],
    [31, d(2026, 11, 30), 31, false],
    [31, d(2026, 12, 24), 7, true],
    // February, plain and leap
    [31, d(2027, 2, 20), 8, false],
    [31, d(2027, 2, 21), 7, true],
    [30, d(2028, 2, 22), 7, true],
    [30, d(2028, 2, 29), 30, false],
    // across the year end
    [3, d(2026, 12, 26), 8, false],
    [3, d(2026, 12, 27), 7, true],
    [3, d(2027, 1, 2), 1, true],
    [3, d(2027, 1, 3), 31, false],
    [1, d(2026, 12, 25), 7, true],
    [1, d(2026, 12, 24), 8, false],
    [1, d(2027, 1, 1), 31, false],
  ];
  it.each(cases)("reset_day %i on %s: %i days, warned %s", (resetDay, today, days, shown) => {
    expect(daysUntilReset(resetDay, today)).toBe(days);
    expect(warned({ ...LIVE, reset_day: resetDay }, today)).toBe(shown);
    // funded: never, even inside the window
    expect(warned({ ...FUNDED, reset_day: resetDay }, today)).toBe(false);
  });
});

describe("hiding the pill", () => {
  it("hides and brings back the pill from its panel, and remembers", async () => {
    await feed(LIVE);
    const s = support();
    s.openPanel();
    const toggle = one(panelOf(), "funding-hide");
    expect(toggle.tagName).toBe("button");
    expect(text(toggle)).toBe("Hide from the status bar");
    toggle.dispatch("click");
    expect(s.pill.hidden).toBe(true);
    expect(pillHidden()).toBe(true);
    expect(text(toggle)).toBe("Show in the status bar");
    expect(panelOpen()).toBe(true); // the panel stays up to undo it

    // a later launch: still hidden, though the data is there
    const next = support();
    expect(next.pill.hidden).toBe(true);
    // the welcome card is not affected
    const card = new FakeEl("div");
    mountFundingCard(card as unknown as HTMLElement)();
    expect(card.hidden).toBe(false);
    // Help > Support SindriCAD still opens the panel
    next.openPanel();
    expect(byClass(body(), "funding-panel").length).toBeGreaterThan(0);

    toggle.dispatch("click");
    expect(s.pill.hidden).toBe(false);
    expect(pillHidden()).toBe(false);
  });

  it("Help > Support with no data shows the ways to support, without a bar or a hide link", () => {
    const s = support();
    s.openPanel();
    const panel = panelOf();
    expect(text(one(panel, "funding-title"))).toBe("Keep SindriCAD in development");
    expect(byClass(panel, "funding-bar")).toHaveLength(0);
    expect(byClass(panel, "funding-hide")).toHaveLength(0);
    expect(buttons(panel).map((b) => b.textContent)).toEqual(SUPPORT_LINKS.map((l) => l.label));
  });
});

describe("closing the panel", () => {
  const key = (k: string) => Object.assign(new Event("keydown", { cancelable: true }), { key: k });
  const pointerAt = (target: unknown) => {
    const e = new Event("pointerdown");
    Object.defineProperty(e, "target", { value: target });
    return e;
  };

  it("Escape closes it and hands focus back to the pill", async () => {
    await feed(LIVE);
    const s = support();
    s.openPanel();
    window.dispatchEvent(key("a"));
    expect(s.isOpen()).toBe(true);
    window.dispatchEvent(key("Escape"));
    expect(s.isOpen()).toBe(false);
    expect(panelOpen()).toBe(false);
    expect(s.pill.getAttribute("aria-expanded")).toBe("false");
  });

  it("a click outside closes it, a click inside does not", async () => {
    await feed(LIVE);
    const s = support();
    s.openPanel();
    window.dispatchEvent(pointerAt(buttons(panelOf())[1]));
    expect(s.isOpen()).toBe(true);
    window.dispatchEvent(pointerAt(new FakeEl("canvas")));
    expect(s.isOpen()).toBe(false);
  });

  it("the pill toggles it", async () => {
    await feed(LIVE);
    const s = support();
    const pill = s.pill as unknown as FakeEl;
    pill.dispatch("click");
    expect(s.isOpen()).toBe(true);
    window.dispatchEvent(pointerAt(pill)); // the pointerdown before the click must not close it first
    pill.dispatch("click");
    expect(s.isOpen()).toBe(false);
  });
});

describe("bad payloads hide the feature", () => {
  const big = "9".repeat(100_000);
  const bad: [string, unknown][] = [
    ["null", null],
    ["a string", "goal 335"],
    ["an array", [335, 147, 44, 20]],
    ["NaN goal", { ...LIVE, goal: Number.NaN }],
    ["Infinity current", { ...LIVE, current: Number.POSITIVE_INFINITY }],
    ["negative current", { ...LIVE, current: -1 }],
    ["zero goal", { ...LIVE, goal: 0 }],
    ["absurd goal", { ...LIVE, goal: 1e12 }],
    ["string amount", { ...LIVE, goal: "335" }],
    ["huge string amount", { ...LIVE, current: big }],
    ["missing goal", { current: 147, percentage: 44, reset_day: 20 }],
    ["missing reset_day", { goal: 335, current: 147, percentage: 44 }],
    ["missing percentage", { goal: 335, current: 147, reset_day: 20 }],
    ["reset_day 0", { ...LIVE, reset_day: 0 }],
    ["reset_day 32", { ...LIVE, reset_day: 32 }],
    ["fractional reset_day", { ...LIVE, reset_day: 20.5 }],
  ];
  it.each(bad)("%s", async (_name, payload) => {
    const s = support();
    const card = new FakeEl("div");
    mountFundingCard(card as unknown as HTMLElement);
    await feed(payload);
    expect(currentFunding()).toBeNull();
    expect(s.pill.hidden).toBe(true);
    expect(card.hidden).toBe(true);
    expect(card.children).toHaveLength(0);
    expect(sanitizeFunding(payload)).toBeNull();
  });

  it("a tampered cache is as bad as a tampered payload", async () => {
    const now = Date.now();
    ls.set("sindri.funding.cache", JSON.stringify({ at: now, goal: { ...LIVE, current: -5 } }));
    await feed(null, now);
    expect(currentFunding()).toBeNull();
    ls.set("sindri.funding.cache", "{not json");
    await feed(null, now);
    expect(currentFunding()).toBeNull();
    ls.set("sindri.funding.cache", JSON.stringify({ at: now + 60_000, goal: LIVE })); // from the future
    await feed(null, now);
    expect(currentFunding()).toBeNull();
  });
});

describe("cache", () => {
  it("keeps the last good value through failures for under a week, then hides", async () => {
    const t0 = Date.UTC(2026, 9, 17, 12);
    const s = support();
    await feed(LIVE, t0);
    expect(pillLabel(s)).toBe("Funding 44%");

    await refreshFunding(() => Promise.reject(new Error("offline")), t0 + 6 * 24 * 3600_000);
    expect(currentFunding()).toEqual(LIVE);
    expect(s.pill.hidden).toBe(false);
    await feed({ garbage: true }, t0 + 6 * 24 * 3600_000);
    expect(currentFunding()).toEqual(LIVE);

    await refreshFunding(() => Promise.reject(new Error("offline")), t0 + CACHE_MAX_AGE_MS + 1);
    expect(currentFunding()).toBeNull();
    expect(s.pill.hidden).toBe(true);
  });

  it("a fresh value replaces the cached one", async () => {
    const t0 = Date.UTC(2026, 9, 17, 12);
    await feed(LIVE, t0);
    await feed({ ...LIVE, current: 200, percentage: 60 }, t0 + REFRESH_MS);
    await feed(null, t0 + REFRESH_MS + 1);
    expect(currentFunding()?.current).toBe(200);
  });

  it("next launch shows the cached value at once, fetches after 3 s, then every 6 hours", async () => {
    await feed(LIVE);
    vi.useFakeTimers();
    vi.resetModules();
    try {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      stub.invoked.length = 0;
      stub.answer = { ...LIVE, current: 150, percentage: 45 };
      const fresh = await import("../tinkeratlas/funding");
      fresh.startFundingUpdates();
      expect(fresh.currentFunding()).toEqual(LIVE); // before any network
      expect(stub.invoked).toEqual([]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(stub.invoked).toEqual(["ta_funding_goal"]);
      expect(fresh.currentFunding()?.current).toBe(150);
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 3001);
      expect(stub.invoked).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); // six hours after launch
      expect(stub.invoked).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(stub.invoked).toHaveLength(3);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      vi.useRealTimers();
    }
  });

  it("the browser build (no Tauri) never asks and shows nothing", async () => {
    vi.resetModules();
    stub.invoked.length = 0;
    const fresh = await import("../tinkeratlas/funding");
    fresh.startFundingUpdates();
    expect(fresh.currentFunding()).toBeNull();
    expect(stub.invoked).toEqual([]);
  });
});

describe("opener scope", () => {
  // Same emulation as help.test.ts: Tauri refuses a URL outside
  // `opener:allow-open-url` at the IPC boundary with no UI at all, so a button
  // whose URL is missing there does nothing in a packaged build.
  it("every support button's URL is allowed, and none is denied", () => {
    const caps = JSON.parse(capabilitiesSrc) as {
      permissions: (string | { identifier: string; allow?: { url?: string }[]; deny?: { url?: string }[] })[];
    };
    const opener = caps.permissions.find(
      (p): p is { identifier: string; allow?: { url?: string }[]; deny?: { url?: string }[] } =>
        typeof p === "object" && p.identifier === "opener:allow-open-url",
    );
    const allow = (opener?.allow ?? []).map((a) => a.url ?? "");
    const deny = (opener?.deny ?? []).map((a) => a.url ?? "");
    const matches = (pattern: string, url: string) =>
      new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(url);
    for (const { url } of SUPPORT_LINKS) {
      expect(allow.some((p) => matches(p, url)), `no opener allow entry for ${url}`).toBe(true);
      expect(deny.some((p) => matches(p, url)), `an opener deny entry blocks ${url}`).toBe(false);
    }
  });
});
