// "Keep SindriCAD in development": the funding pill in the title bar's status
// area, the small panel it opens, and the same content as a card on the welcome
// screen. Data and its validation live in tinkeratlas/funding.ts.
//
// Visible, never intrusive: nothing here opens by itself, nothing animates, and
// the pill can be hidden for good from its own panel. Help > Support SindriCAD
// still opens the panel after that, and works with no data at all (offline, or
// the browser build): it then shows the ways to support without the bar.
//
// Every string on screen is built here from validated numbers through t(); the
// server's own status sentence is never shown (English-only and untrusted).

import { icon } from "./icons";
import { localeTag, setText, setTitle, t } from "../i18n";
import { openHelp } from "./help";
import { isImeComposing } from "./focus";
import {
  currentFunding,
  isFunded,
  onFundingChange,
  stopWarningDue,
  type FundingGoal,
} from "../tinkeratlas/funding";

/** In the order Thomas chose: PayPal is what most people pick, then Ko-fi.
 *  Each URL needs an `opener:allow-open-url` entry in
 *  src-tauri/capabilities/default.json, or the button silently opens nothing
 *  in a packaged build (funding.test.ts pins that). */
export const SUPPORT_LINKS = [
  { label: "PayPal", url: "https://paypal.me/makerviking", primary: true },
  { label: "Ko-fi", url: "https://ko-fi.com/tinkeratlas", primary: false },
  { label: "TinkerAtlas", url: "https://tinkeratlas.com/pricing", primary: false },
] as const;

const HIDE_KEY = "sindri.funding.pillHidden";

export function pillHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === "true";
  } catch {
    return false;
  }
}

function setPillHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(HIDE_KEY, "true");
    else localStorage.removeItem(HIDE_KEY);
  } catch {
    // storage disabled: the choice lasts this session only
  }
}

// Whole dollars: a running-costs goal in cents would be noise. Grouping and the
// symbol's position follow the UI language; digits stay Latin like units.ts.
function money(n: number): string {
  return new Intl.NumberFormat(localeTag(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    numberingSystem: "latn",
  }).format(n);
}

function percent(p: number): string {
  return new Intl.NumberFormat(localeTag(), { style: "percent", maximumFractionDigits: 0, numberingSystem: "latn" }).format(p / 100);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

/** The body shared by the panel and the welcome card. With no goal it is the
 *  title and the buttons only. */
export function renderFundingBody(host: HTMLElement, goal: FundingGoal | null, today = new Date()): void {
  host.innerHTML = "";
  const title = el("h3", "funding-title");
  setText(title, "funding.title");
  host.appendChild(title);

  if (goal) {
    const funded = isFunded(goal);
    // Floor what's raised and ceil what's missing, so $334.60 of $335 never
    // reads "$335 of $335" next to "$0 still needed".
    const amounts = t("funding.amounts", { current: money(Math.floor(goal.current)), goal: money(goal.goal) });

    const bar = el("div", "funding-bar");
    bar.classList.toggle("funded", funded);
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(goal.percentage));
    bar.setAttribute("aria-valuetext", amounts);
    bar.setAttribute("aria-label", t("funding.barLabel"));
    const fill = el("div", "funding-bar-fill");
    fill.style.width = `${goal.percentage}%`;
    bar.appendChild(fill);
    host.appendChild(bar);

    const amountLine = el("p", "funding-amounts");
    amountLine.textContent = amounts;
    host.appendChild(amountLine);

    const status = el("p", "funding-status");
    status.classList.toggle("funded", funded);
    if (funded) setText(status, "funding.funded");
    else setText(status, "funding.needed", { amount: money(Math.ceil(goal.goal - goal.current)) });
    host.appendChild(status);

    if (stopWarningDue(goal, today)) {
      const warn = el("p", "funding-warning");
      const text = el("span", "");
      setText(text, "funding.pauseWarning");
      warn.innerHTML = icon("warning");
      warn.appendChild(text);
      host.appendChild(warn);
    }
  }

  const links = el("div", "funding-links");
  for (const link of SUPPORT_LINKS) {
    const b = el("button", "choice-btn");
    b.classList.toggle("choice-primary", link.primary);
    b.type = "button";
    b.textContent = link.label;
    b.dataset.url = link.url;
    b.addEventListener("click", () => void openHelp(link.url));
    links.appendChild(b);
  }
  host.appendChild(links);
}

/** The welcome screen's card: live, so a fetch landing while the screen is up
 *  fills it in. Hidden (empty) without data. Returns the unsubscribe. */
export function mountFundingCard(host: HTMLElement): () => void {
  return onFundingChange((goal) => {
    host.hidden = !goal;
    if (goal) renderFundingBody(host, goal);
    else host.innerHTML = "";
  });
}

/** The title-bar pill and its panel. One instance, made in main.ts. */
export class FundingSupport {
  readonly pill: HTMLButtonElement;
  private panel: HTMLDivElement | null = null;
  private unsubPanel: (() => void) | null = null;

  private onKey = (e: KeyboardEvent) => {
    if (!this.panel || e.key !== "Escape" || isImeComposing(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.closePanel();
    if (!this.pill.hidden) this.pill.focus();
  };
  private onPointer = (e: Event) => {
    if (!this.panel) return;
    const target = e.target as Node | null;
    if (this.panel.contains(target) || this.pill.contains(target)) return;
    this.closePanel();
  };

  constructor() {
    this.pill = el("button", "funding-pill");
    this.pill.type = "button";
    this.pill.hidden = true;
    this.pill.setAttribute("aria-haspopup", "dialog");
    this.pill.setAttribute("aria-expanded", "false");
    this.pill.addEventListener("click", () => (this.panel ? this.closePanel() : this.openPanel()));
    onFundingChange(() => this.renderPill());
  }

  private renderPill(): void {
    const goal = currentFunding();
    this.pill.hidden = !goal || pillHidden();
    this.pill.innerHTML = icon("heart");
    if (!goal) return;
    const label = el("span", "");
    if (isFunded(goal)) setText(label, "funding.pillFunded");
    else setText(label, "funding.pill", { percent: percent(goal.percentage) });
    this.pill.appendChild(label);
    setTitle(this.pill, "funding.title");
  }

  isOpen(): boolean {
    return this.panel !== null;
  }

  openPanel(): void {
    if (this.panel) return;
    const panel = el("div", "funding-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", t("funding.title"));
    panel.tabIndex = -1;
    // Under the pill when it shows; otherwise the same corner, under the bar.
    if (!this.pill.hidden && this.pill.isConnected) {
      const r = this.pill.getBoundingClientRect();
      panel.style.top = `${Math.round(r.bottom + 6)}px`;
      panel.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    }
    document.body.appendChild(panel);
    this.panel = panel;
    this.unsubPanel = onFundingChange((goal) => this.renderPanel(goal));
    this.pill.setAttribute("aria-expanded", "true");
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("pointerdown", this.onPointer, true);
    panel.focus();
  }

  closePanel(): void {
    if (!this.panel) return;
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("pointerdown", this.onPointer, true);
    this.unsubPanel?.();
    this.unsubPanel = null;
    this.panel.remove();
    this.panel = null;
    this.pill.setAttribute("aria-expanded", "false");
  }

  private renderPanel(goal: FundingGoal | null): void {
    const panel = this.panel;
    if (!panel) return;
    renderFundingBody(panel, goal);
    // Only offered when there is a pill to hide or bring back.
    if (!goal) return;
    const toggle = el("button", "funding-hide");
    toggle.type = "button";
    setText(toggle, pillHidden() ? "funding.showPill" : "funding.hidePill");
    toggle.addEventListener("click", () => {
      setPillHidden(!pillHidden());
      this.renderPill();
      // relabel in place: re-rendering would drop the keyboard focus
      setText(toggle, pillHidden() ? "funding.showPill" : "funding.hidePill");
    });
    panel.appendChild(toggle);
  }
}
