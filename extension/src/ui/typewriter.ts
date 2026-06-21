// Typewriter animation: writes `text` into `el.textContent` one grapheme at a
// time using requestAnimationFrame. Pure presentation; the text source can be
// untrusted (LLM output) because we ONLY ever assign to textContent.
//
// Cancellation: each call returns a `cancel()` and also accepts an AbortSignal
// so a re-render (showLoading -> showResult mid-typing) can stop the previous
// animation cleanly with no dangling rAF or partial double-writes.
//
// Reduced motion: when the user prefers reduced motion we write the full text
// immediately and resolve onDone synchronously on the next microtask, so the
// stagger logic in callers still sees a consistent "finished" signal.

export interface TypewriterOptions {
  /** Characters per second. Default ~70 (≈14ms/char). */
  cps?: number;
  /** Called once when the full text has been written (or on instant write). */
  onDone?: () => void;
  /** External cancellation. When aborted, the animation stops; onDone is NOT called. */
  signal?: AbortSignal;
  /** Append the caret element while typing; removed on completion. */
  caret?: HTMLElement | null;
}

export interface TypewriterHandle {
  /** Stop the animation in place. Idempotent. onDone is NOT fired. */
  cancel(): void;
  /** Skip to the end immediately, write full text, fire onDone. Idempotent. */
  finish(): void;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function typewriter(
  el: HTMLElement,
  text: string,
  opts: TypewriterOptions = {},
): TypewriterHandle {
  const { cps = 70, onDone, signal, caret } = opts;
  let cancelled = false;
  let finished = false;
  let rafId = 0;

  function detachCaret(): void {
    if (caret && caret.parentNode === el) el.removeChild(caret);
  }

  function complete(): void {
    if (finished || cancelled) return;
    finished = true;
    el.textContent = text;
    detachCaret();
    onDone?.();
  }

  function cancel(): void {
    if (finished || cancelled) return;
    cancelled = true;
    if (rafId) cancelAnimationFrame(rafId);
    detachCaret();
  }

  if (signal) {
    if (signal.aborted) {
      cancelled = true;
      return { cancel, finish: complete };
    }
    signal.addEventListener('abort', cancel, { once: true });
  }

  // Reduced motion or empty text: write instantly.
  if (prefersReducedMotion() || text.length === 0) {
    queueMicrotask(complete);
    return { cancel, finish: complete };
  }

  el.textContent = '';
  if (caret) el.appendChild(caret);

  const msPerChar = 1000 / Math.max(1, cps);
  let last = performance.now();
  let acc = 0;
  let i = 0;
  // Grapheme-safe iteration: use Array.from to keep emojis/combining marks intact.
  const chars = Array.from(text);

  function step(now: number): void {
    if (cancelled || finished) return;
    acc += now - last;
    last = now;
    while (acc >= msPerChar && i < chars.length) {
      i++;
      acc -= msPerChar;
    }
    if (caret) {
      // Insert text BEFORE the caret so the cursor stays at the tail.
      el.textContent = chars.slice(0, i).join('');
      el.appendChild(caret);
    } else {
      el.textContent = chars.slice(0, i).join('');
    }
    if (i >= chars.length) {
      complete();
      return;
    }
    rafId = requestAnimationFrame(step);
  }
  rafId = requestAnimationFrame(step);

  return { cancel, finish: complete };
}

/** Create a blinking caret element (CSS handles the blink animation). */
export function createCaret(): HTMLSpanElement {
  const c = document.createElement('span');
  c.className = 'ml-typewriter-caret';
  c.setAttribute('aria-hidden', 'true');
  c.textContent = '▍';
  return c;
}
