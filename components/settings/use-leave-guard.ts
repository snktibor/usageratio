"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Whether a click on this link leaves the page: a same-origin link to another
 * path or query, followed in this tab. In-page anchors (the settings menu),
 * new tabs, downloads and modified clicks leave nothing behind.
 */
export function leavesPage(link: HTMLAnchorElement, event: MouseEvent, here: Location): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (link.hasAttribute("download")) return false;
  const target = link.getAttribute("target");
  if (target && target !== "_self") return false;
  const url = new URL(link.href, here.href);
  if (url.origin !== here.origin) return false;
  return url.pathname !== here.pathname || url.search !== here.search;
}

/**
 * Warns before unsaved changes are left behind: the browser's own prompt for
 * a reload, a closed tab or a typed address, and the caller's confirmation
 * (`pending` set, then `stay()` or `leave()`) for an in-app link or for any
 * action handed to `confirmLeave` (such as switching the language).
 */
export function useLeaveGuard(dirty: boolean) {
  const router = useRouter();
  const [pending, setPending] = useState<(() => void) | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers only show the prompt when a return value is set.
      event.returnValue = "";
    };
    // Capturing on window runs before React's own listeners, so the link's navigation never starts.
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement) || !leavesPage(link, event, window.location)) return;
      event.preventDefault();
      event.stopPropagation();
      const href = link.href;
      setPending(() => () => router.push(href));
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [dirty, router]);

  return {
    /** The navigation waiting for an answer, or null. */
    pending: pending !== null,
    confirmLeave: (proceed: () => void) => {
      if (dirtyRef.current) setPending(() => proceed);
      else proceed();
    },
    stay: () => setPending(null),
    leave: () => {
      const proceed = pending;
      setPending(null);
      proceed?.();
    },
  };
}
