"use client";

import { useRouter } from "@/i18n/routing";
import { useEffect } from "react";

/**
 * Re-renders the server components on a timer and when the tab becomes
 * visible again. The previous render stays on screen until the new one is in.
 */
export function AutoRefresh({ intervalMs = 5 * 60_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let lastRefresh = Date.now();
    const refresh = () => {
      lastRefresh = Date.now();
      router.refresh();
    };

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, intervalMs);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRefresh > 60_000) refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router, intervalMs]);

  return null;
}
