// Lightweight toast notifications — a bottom-center stack above the timeline.
// The one job: make sure nothing important can happen SILENTLY. A committed
// feature that fails in the rebuild used to show only a small status line while
// the model stayed visually unchanged — indistinguishable from "nothing
// happened". Errors persist longer and carry an optional action button
// ("Show" → select the failing feature).

export interface ToastOptions {
  kind?: "error" | "warning" | "info";
  action?: { label: string; onClick: () => void };
  timeout?: number; // ms; default from toastTimeout. 0 = STICKY, never auto-dismissed.
  /** Leave the toast up after its action runs. For an action that SHOWS
   *  something (Show: the failing feature) rather than one that settles it:
   *  the message is still what the user is reading, and dismissing it on Show
   *  threw away the only copy on screen (4875dacc). */
  keepOnAction?: boolean;
}

import { crumb } from "../diagnostics/breadcrumbs";
import { icon } from "./icons";
import { sourceOf, t } from "../i18n";

let stack: HTMLDivElement | null = null;

/** Reading time per character for an error or warning, and the most it adds up to. */
const READ_MS_PER_CHAR = 70;
const READ_CAP_MS = 30000;
/** What a toast has left when the pointer moves off it, at the least. */
const RESUME_MIN_MS = 2000;

/** How long a toast stays up unless the caller says. Info is a glance. An error
 *  or a warning is a sentence to read, sometimes a paragraph: a refused
 *  press/pull runs to 364 characters, and a flat 8 s took it away mid-read ("the
 *  warning message disappears far too quickly, I don't get time to read and
 *  understand it or copy it", 4875dacc). Those get reading time for their
 *  length on top of the old floor, capped so nothing lingers for minutes. */
export function toastTimeout(kind: NonNullable<ToastOptions["kind"]>, message: string): number {
  if (kind === "info") return 3500;
  const floor = kind === "error" ? 8000 : 6000;
  return Math.min(READ_CAP_MS, Math.max(floor, 1000 + READ_MS_PER_CHAR * message.length));
}

function ensureStack(): HTMLDivElement {
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

/** Show a toast. Returns a function that dismisses it (harmless once it has
 *  gone), for a toast whose message can stop being true while it is up. */
export function toast(message: string, opts: ToastOptions = {}): () => void {
  const host = ensureStack();
  const kind = opts.kind ?? "info";
  // Toasts double as bug-report breadcrumbs. The crumb is the ENGLISH text plus
  // the key, never the translation, so support can grep a report from any
  // locale; text that did not come through t() is logged as shown.
  const src = sourceOf(message);
  crumb(src ? `[${kind}] ${src.english} <${src.key}>` : `[${kind}] ${message}`);
  // keep the stack short — oldest goes first, but never evict one the user is
  // actually reading (hovered or focused): a burst of toasts used to yank a
  // held one out from under the pointer (812d934a, "I had 19 notifications").
  // If every toast on screen is held, let the stack grow past the cap rather
  // than evict one mid-read.
  while (host.children.length >= 3) {
    const victim = Array.from(host.children).find((c) => !c.classList.contains("toast-held"));
    if (!victim) break;
    victim.remove();
  }

  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;
  el.appendChild(msg);

  let timer = 0;
  let closed = false;
  const dismiss = () => {
    closed = true;
    window.clearTimeout(timer);
    el.classList.add("toast-out");
    window.setTimeout(() => el.remove(), 180);
  };

  if (opts.action) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = opts.action.label;
    btn.addEventListener("click", () => {
      opts.action!.onClick();
      if (!opts.keepOnAction) dismiss();
    });
    el.appendChild(btn);
  }
  // A copy icon on error/warning only: those are the toasts with substantial
  // text worth pasting into a bug report or Discord (9a902591). An info toast
  // is a 3.5 s glance ("Saved") with nothing worth copying.
  if (kind === "error" || kind === "warning") {
    const copyBtn = document.createElement("button");
    copyBtn.className = "toast-copy";
    copyBtn.setAttribute("aria-label", t("toast.copy"));
    copyBtn.innerHTML = icon("copy");
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(message).then(() => {
        copyBtn.innerHTML = icon("check");
        copyBtn.setAttribute("aria-label", t("toast.copied"));
        window.setTimeout(() => {
          copyBtn.innerHTML = icon("copy");
          copyBtn.setAttribute("aria-label", t("toast.copy"));
        }, 1000);
      });
    });
    el.appendChild(copyBtn);
  }
  const close = document.createElement("button");
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss");
  close.innerHTML = icon("close");
  close.addEventListener("click", dismiss);
  el.appendChild(close);

  host.appendChild(el);
  // timeout 0 means the caller has something the user must not lose by looking
  // away. Nothing turns sticky by accident: nothing passes 0 unless it means it.
  const ms = opts.timeout ?? toastTimeout(kind, message);
  // Reading it, selecting its text or reaching for its button holds it up: the
  // countdown stops while the pointer is over the toast or focus is inside it,
  // and resumes with what was left once both have gone.
  let left = ms;
  let since = 0;
  let hovered = false;
  let focused = false;
  const run = () => {
    if (ms <= 0 || hovered || focused || closed) return;
    since = Date.now();
    timer = window.setTimeout(dismiss, left);
  };
  const hold = () => {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = 0;
    left = Math.max(RESUME_MIN_MS, left - (Date.now() - since));
  };
  // Marks the element as held independent of the dismiss timer, so the 3-cap
  // eviction above can skip it even for a sticky (timeout: 0) toast.
  const updateHeld = () => el.classList.toggle("toast-held", hovered || focused);
  el.addEventListener("mouseenter", () => {
    hovered = true;
    updateHeld();
    hold();
  });
  el.addEventListener("mouseleave", () => {
    hovered = false;
    updateHeld();
    run();
  });
  el.addEventListener("focusin", () => {
    focused = true;
    updateHeld();
    hold();
  });
  el.addEventListener("focusout", () => {
    focused = false;
    updateHeld();
    run();
  });
  run();
  return dismiss;
}
