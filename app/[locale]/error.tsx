"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 pt-6 sm:px-8 sm:pt-8">
      <p className="text-lg font-medium tracking-tight">usageratio</p>
      <div className="mt-[18vh] max-w-xl">
        <h1 className="text-4xl font-semibold tracking-tight">Az oldal nem tudott betölteni</h1>
        <p className="mt-4 text-ink-2">
          Váratlan hiba történt a megjelenítés közben. A részletek a Vercel-projekt futásidejű naplójában vannak.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-8 rounded-md bg-ink px-4 py-2.5 font-medium text-page transition-opacity hover:opacity-90"
        >
          Újrapróbálás
        </button>
      </div>
    </main>
  );
}
