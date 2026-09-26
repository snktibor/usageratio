"use client";

import { Instrument_Sans } from "next/font/google";
import "./globals.css";

// global-error replaces the root layout, so it brings its own font and styles.
const instrumentSans = Instrument_Sans({
  subsets: ["latin", "latin-ext"],
  axes: ["wdth"],
  variable: "--font-instrument",
  display: "swap",
});

/**
 * The last resort: an error in the locale layout itself, where no messages
 * are loaded yet. English only, with the same shell as the other pages.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en" className={instrumentSans.variable}>
      <body className="min-h-dvh">
        <main className="mx-auto w-full max-w-4xl px-5 pt-6 sm:px-8 sm:pt-8">
          <p className="text-lg font-medium tracking-tight">usageratio</p>
          <div className="mt-[18vh] max-w-xl">
            <h1 className="text-4xl font-semibold tracking-tight">The page could not load</h1>
            <p className="mt-4 text-ink-2">
              Something went wrong while rendering. The details are in the deployment's runtime log.
            </p>
            {error.digest && <p className="mt-2 font-mono text-xs text-ink-3">Error id: {error.digest}</p>}
            <button
              type="button"
              onClick={() => retry()}
              className="mt-8 rounded-md bg-ink px-4 py-2.5 font-medium text-page transition-opacity hover:opacity-90"
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
