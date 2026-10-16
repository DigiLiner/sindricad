// Camera navigation that starts over a sketch badge (a dimension or a
// constraint glyph). The badges live in #viewport-overlay, a SIBLING of the
// canvas, and take pointer events so they can be clicked, dragged and edited —
// which meant a wheel turn or a middle/right press over one never reached the
// canvas, where the zoom, orbit and pan live: report 9dec2462, "no zoom, pan or
// orbit while the pointer is over a dimension". These hand those gestures on to
// the canvas as the same event, so every listener there (the viewport's wheel
// zoom, camera-controls, the free orbit) runs exactly as if the badge were not
// in the way. The primary button stays the badge's own.

/** How far a right press may travel and still be a click rather than a pan —
 *  the threshold the canvas's own right-click/pan split uses (viewport.ts). */
const PAN_PX = 5;

/** A wheel turn over a badge zooms, as it would one pixel to either side. Not
 *  while it is over an open inline editor: that is a field being typed in, and
 *  zooming would carry it away from under the caret. */
export function forwardWheel(e: WheelEvent, canvas: HTMLElement) {
  if ((e.target as Element | null)?.tagName?.toUpperCase() === "INPUT") return;
  e.preventDefault(); // the canvas's listener cancels its own copy, not this one
  canvas.dispatchEvent(new WheelEvent(e.type, e));
}

/** A middle or right press over a badge starts the canvas's orbit or pan. */
export function forwardPress(e: PointerEvent, canvas: HTMLElement) {
  canvas.dispatchEvent(new PointerEvent(e.type, e));
}

/** A right press over a badge is either a click, which opens the badge's own
 *  menu, or a drag, which pans and must not ALSO open it — the same split the
 *  canvas makes. WebKit fires `contextmenu` while the button is still down, so
 *  the menu waits for the release there; a platform that fires it after the
 *  release is answered straight away. One per badge layer. */
export class BadgeRightPress {
  private down: { x: number; y: number } | null = null;
  private moved = false;
  private pending: (() => void) | null = null;

  /** From the badge's pointerdown, for button 2. */
  begin(e: PointerEvent) {
    this.down = { x: e.clientX, y: e.clientY };
    this.moved = false;
    this.pending = null;
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onEnd);
    window.addEventListener("pointercancel", this.onEnd);
  }

  /** From the badge's contextmenu: run `open` if this right press was a click. */
  menu(open: () => void) {
    if (this.down) this.pending = open;
    else if (!this.moved) open();
  }

  private onMove = (e: PointerEvent) => {
    if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > PAN_PX) this.moved = true;
  };

  private onEnd = (e: PointerEvent) => {
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onEnd);
    window.removeEventListener("pointercancel", this.onEnd);
    this.down = null;
    const open = this.pending;
    this.pending = null;
    if (open && !this.moved && e.type === "pointerup") open();
  };
}
