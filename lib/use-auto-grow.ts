"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Grow a textarea to fit its content instead of scrolling it.
 *
 * Both panes are read as a document, so a line that wraps has to show every
 * line it wraps to. The panes used to guess a row count from the character
 * count (`rows={Math.ceil(text.length / 40)}`), which silently hid the
 * overflow behind a scrollbar whenever the guess came in low — an explicit
 * line break, a narrow pane, or any mix of Latin and CJK all broke the guess.
 *
 * Attach the returned ref to the textarea. Pass the current value so the
 * height is recomputed on every edit; width changes are watched separately,
 * since a narrower box wraps to more lines.
 */
export function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Collapse first, or scrollHeight reports the previous (larger) height and
    // the box can only ever grow.
    el.style.height = "auto";
    // scrollHeight excludes borders but `height` includes them under
    // border-box, so a bordered textarea clips its last line by exactly the
    // border width — 2px on the summary field. Add it back.
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + borders}px`;
  }, []);

  useLayoutEffect(fit, [value, fit]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const current = ref.current;
      if (!current) return;
      // React to width only. Our own height writes resize the element too, and
      // responding to those would loop forever.
      if (current.clientWidth === lastWidth) return;
      lastWidth = current.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  return ref;
}
