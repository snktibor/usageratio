import { logout } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { DashboardView } from "@/components/dashboard-view";
import { SettingsDialog } from "@/components/settings-dialog";
import type { DashboardModel } from "@/lib/dashboard";
import { formatClock, formatDateTime, formatTokens } from "@/lib/format";
import type { SettingsView } from "@/lib/settings";

const MODE_NOTE = {
  delta: "A beküldött tokenszámok összeadódnak (delta mód).",
  snapshot: "Gépenként a ciklus legutolsó beküldött állása számít (snapshot mód).",
  counter: "Gépenként a számláló ciklusbeli növekménye számít (counter mód).",
} as const;

export function Dashboard({ model, settings }: { model: DashboardModel; settings: SettingsView }) {
  const refreshedAt = formatClock(model.generatedAt, model.timeZone);

  return (
    <div className="mx-auto w-full max-w-4xl px-5 pb-16 pt-6 sm:px-8 sm:pt-8">
      <AutoRefresh />

      <header className="flex items-center justify-between gap-4">
        <p className="text-lg font-medium tracking-tight">usageratio</p>
        <div className="flex items-center gap-3 text-sm text-ink-3 sm:gap-4">
          <span title={`Frissítve ${refreshedAt}`} className="mr-1">
            <span className="sr-only sm:not-sr-only">Frissítve </span>
            {refreshedAt}
          </span>
          <SettingsDialog view={settings} />
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

      <DashboardView model={model} />

      <footer className="mt-16 max-w-2xl border-t border-hairline pt-6 text-sm leading-relaxed text-ink-3">
        <p>
          A mostani ciklus: {formatDateTime(model.cycle.startMs, model.timeZone)} –{" "}
          {formatDateTime(model.cycle.endMs, model.timeZone)} ({model.timeZone}). Az előző ciklusban a gépek{" "}
          {formatTokens(model.previousTotal)} tokent mértek.
        </p>
        <p className="mt-1">{MODE_NOTE[model.tokenMode]}</p>
      </footer>
    </div>
  );
}
