/** Shown instead of the dashboard when Redis is missing or unreachable. Carries no usage data. */
export function StorageProblem({ notConfigured }: { notConfigured: boolean }) {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 pt-6 sm:px-8 sm:pt-8">
      <p className="text-lg font-medium tracking-tight">usageratio</p>

      <div className="mt-[18vh] max-w-xl">
        <h1 className="text-4xl font-semibold tracking-tight">
          {notConfigured ? "Az adattár nincs bekötve" : "Az adattár most nem érhető el"}
        </h1>
        {notConfigured ? (
          <p className="mt-4 text-ink-2">
            Hiányzik a <code className="text-ink">KV_REST_API_URL</code> és a{" "}
            <code className="text-ink">KV_REST_API_TOKEN</code> környezeti változó. Kösd a Vercel-projekthez
            az Upstash Redis adatbázist (Storage fül), majd telepítsd újra az alkalmazást.
          </p>
        ) : (
          <p className="mt-4 text-ink-2">
            A Redis nem válaszolt. A kliensek beküldései ilyenkor sem vesznek el végleg, a következő órában
            újra jelentenek. Töltsd újra az oldalt egy perc múlva.
          </p>
        )}
        <a
          href="/"
          className="mt-8 inline-block rounded-md bg-ink px-4 py-2.5 font-medium text-page transition-opacity hover:opacity-90"
        >
          Újratöltés
        </a>
      </div>
    </main>
  );
}
