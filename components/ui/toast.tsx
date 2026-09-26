"use client";

import { type ReactNode, useEffect } from "react";

const DISMISS_MS = 5000;

/**
 * A confirmation that clears itself after a few seconds, so it never lingers
 * once its content is stale. No store, no external state: `onDismiss` is
 * expected to clear whatever put `children` there.
 */
export function Toast({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div role="status" aria-live="polite">
      {children}
    </div>
  );
}
