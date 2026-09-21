import { logout } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { GroupBreakdown } from "@/components/group-breakdown";
import { MachineTable } from "@/components/machine-table";
import { QuotaMeter } from "@/components/quota-meter";
import type { DashboardModel } from "@/lib/dashboard";
import { formatClock, formatDateTime, formatTokens } from "@/lib/format";

const MODE_NOTE = {
  delta: "A beküldött tokenszámok összeadódnak (delta mód).",
  snapshot: "Gépenként a ciklus legutolsó beküldött állása számít (snapshot mód).",
  counter: "Gépenként a számláló ciklusbeli növekménye számít (counter mód).",
} as const;

export function Dashboard({ model }: { model: DashboardModel }) {
  const hasMachines = model.machines.length > 0;

  return (
    <div className="mx-auto w-full max-w-4xl px-5 pb-16 pt-6 sm:px-8 sm:pt-8">
      <AutoRefresh />

      <header className="flex items-center justify-between gap-4">
        <p className="text-lg font-medium tracking-tight">usageratio</p>
        <div className="flex items-center gap-5 text-sm text-ink-3">
          <span>Frissítve {formatClock(model.generatedAt, model.timeZone)}</span>
          <form action={logout}>
            <button
              type="submit"
              className="rounded-md border border-rule px-3 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
            >
              Kilépés
            </button>
          </form>
        </div>
      </header>

      <main className="mt-14 space-y-16 sm:mt-20">
        <QuotaMeter model={model} />

        {hasMachines ? (
          <>
            <GroupBreakdown model={model} />
            <MachineTable model={model} />
          </>
        ) : (
          <section aria-labelledby="empty-heading" className="max-w-xl">
            <h2 id="empty-heading" className="text-xl font-medium">
              Még egy gép sem jelentett
            </h2>
            <p className="mt-3 text-ink-2">
              Telepítsd a kliens szkriptet a gépeidre a repó <code className="text-ink">clients/</code>{" "}
              mappájából. Az első sikeres beküldés után itt jelenik meg a csoportok és a gépek bontása.
            </p>
          </section>
        )}
      </main>

      <footer className="mt-16 max-w-2xl border-t border-hairline pt-6 text-sm leading-relaxed text-ink-3">
        <p>
          A mostani ciklus: {formatDateTime(model.cycle.startMs, model.timeZone)} –{" "}
          {formatDateTime(model.cycle.endMs, model.timeZone)} ({model.timeZone}). Az előző ciklusban{" "}
          {formatTokens(model.previousTotal)} token fogyott.
        </p>
        <p className="mt-1">{MODE_NOTE[model.tokenMode]}</p>
      </footer>
    </div>
  );
}
