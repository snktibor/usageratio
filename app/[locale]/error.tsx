"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";

/**
 * The error boundary of every page under the locale layout (a Client
 * Component, as Next requires). `retry` re-fetches and re-renders the page;
 * the server-side details are in the deployment's log under `error.digest`.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("Errors");

  useEffect(() => {
    // The server logged the stack; the browser console gets the id to look it up by.
    console.error("[usageratio] The page could not render.", error.digest ?? error.message);
  }, [error]);

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pt-6 sm:px-8 sm:pt-8">
      <p className="text-lg font-medium tracking-tight">usageratio</p>
      <div className="mt-[18vh] max-w-xl">
        <h1 className="text-4xl font-semibold tracking-tight">{t("page_failed_title")}</h1>
        <p className="mt-4 text-ink-2">{t("page_failed_desc")}</p>
        {error.digest && <p className="mt-2 font-mono text-xs text-ink-3">{t("error_id", { digest: error.digest })}</p>}
        <button
          type="button"
          onClick={() => retry()}
          className="mt-8 rounded-md bg-ink px-4 py-2.5 font-medium text-page transition-opacity hover:opacity-90"
        >
          {t("retry")}
        </button>
      </div>
    </main>
  );
}
