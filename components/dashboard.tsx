import { getLocale, getTranslations } from "next-intl/server";
import { logout } from "@/app/actions";
import { ArchivedCycleView, type PastSummary } from "@/components/archived-cycle-view";
import { AutoRefresh } from "@/components/auto-refresh";
import { CycleBar } from "@/components/cycle-bar";
import { DashboardView, type HistoryContext } from "@/components/dashboard-view";
import { DownloadIcon, ExportIcon, GitHubIcon, LogOutIcon, SlidersIcon } from "@/components/icons";
import { Link } from "@/i18n/routing";
import { getConfig } from "@/lib/config";
import type { CycleOption, CycleSelection } from "@/lib/cycle-options";
import type { ProviderDashboardModel } from "@/lib/dashboard";
import { isDemoMode } from "@/lib/demo/mode";
import { formatClock } from "@/lib/format";
import type { CycleSummary } from "@/lib/history";
import type { Translator } from "@/lib/i18n";
import { version } from "@/package.json";

export type { PastSummary };

const REPO_URL = "https://github.com/snktibor/usageratio";

/**
 * Plain links, not a fetch: the browser's own download UI handles the
 * `Content-Disposition: attachment` response (see app/api/export/route.ts).
 * Exports every visible provider's cycle on screen: the endpoint knows the
 * current and the previous one (a specific provider is reachable through its
 * query parameters too). Allowed in demo mode too: it only reads, never writes.
 */
function ExportMenu({ t, cycle }: { t: Translator<"HomePage">; cycle: "current" | "previous" }) {
  return (
    <details className="relative">
      <summary className="flex list-none items-center gap-2 rounded-md border border-rule px-2.5 py-1.5 text-ink-2 transition-colors marker:content-none hover:border-ink-3 hover:text-ink sm:px-3 [&::-webkit-details-marker]:hidden">
        <ExportIcon />
        <span className="sr-only sm:not-sr-only">{t("export")}</span>
      </summary>
      <div className="absolute right-0 z-10 mt-2 w-40 rounded-md border border-rule bg-raised p-1.5 text-sm shadow-lg">
        <a
          href={`/api/export?format=csv&cycle=${cycle}`}
          className="block rounded px-2.5 py-1.5 text-ink-2 transition-colors hover:bg-page hover:text-ink"
        >
          {t("export_csv")}
        </a>
        <a
          href={`/api/export?format=json&cycle=${cycle}`}
          className="block rounded px-2.5 py-1.5 text-ink-2 transition-colors hover:bg-page hover:text-ink"
        >
          {t("export_json")}
        </a>
      </div>
    </details>
  );
}

export async function Dashboard({
  providers,
  summaries,
  timeZone,
  generatedAt,
  historyByProvider,
  options,
  selection,
  exportCycle,
  groupColors,
  costEstimate,
}: {
  /** Empty for a cycle known only from its archived summaries (`summaries`), and on a fresh install. */
  providers: ProviderDashboardModel[];
  summaries: PastSummary[];
  /** The saved time zone. */
  timeZone: string;
  generatedAt: number;
  historyByProvider: Record<string, CycleSummary[]>;
  /** The cycles that can be opened, and the one on screen: see lib/cycle-options.ts. */
  options: CycleOption[];
  selection: CycleSelection;
  /** What the export menu downloads; null: the endpoint cannot export the cycle on screen. */
  exportCycle: "current" | "previous" | null;
  groupColors: Record<string, string>;
  /** The settings' cost estimate: the archived summaries show the energy and water behind their cost. */
  costEstimate: boolean;
}) {
  const locale = await getLocale();
  const t = await getTranslations("HomePage");
  const tDashboard = await getTranslations("Dashboard");
  const refreshedAt = formatClock(generatedAt, timeZone, locale);
  const { selected } = selection;
  const historyContext: HistoryContext = {
    groupColors,
    kinds: Object.fromEntries(options.map((option) => [option.startMs, option.kind])),
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-5 pb-16 pt-6 sm:px-8 sm:pt-8">
      {/* A past cycle does not change any more. */}
      {selected.kind === "current" && <AutoRefresh />}

      {/* The narrowest phones get the buttons on a row of their own rather than a page wider than the screen. */}
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <p className="text-lg font-medium tracking-tight">usageratio</p>
        <div className="ml-auto flex items-center gap-2 text-sm text-ink-3 sm:gap-4">
          <span title={t("dashboard_updated_title", { refreshedAt })} className="mr-1">
            <span className="sr-only sm:not-sr-only">{t("dashboard_updated_prefix")}</span>
            {refreshedAt}
          </span>
          <Link
            href="/setup"
            className="flex items-center gap-2 rounded-md border border-rule px-2.5 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink sm:px-3"
          >
            <DownloadIcon />
            <span className="sr-only sm:not-sr-only">{t("dashboard_setup")}</span>
          </Link>
          {providers.length > 0 && exportCycle && <ExportMenu t={t} cycle={exportCycle} />}
          <Link
            href="/settings"
            className="flex items-center gap-2 rounded-md border border-rule px-2.5 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink sm:px-3"
          >
            <SlidersIcon />
            <span className="sr-only sm:not-sr-only">{t("dashboard_settings")}</span>
          </Link>
          {!isDemoMode() && (
            <form action={logout}>
              <button
                type="submit"
                className="flex items-center gap-2 rounded-md border border-rule px-2.5 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink sm:px-3"
              >
                <LogOutIcon />
                <span className="sr-only sm:not-sr-only">{t("dashboard_logout")}</span>
              </button>
            </form>
          )}
        </div>
      </header>

      <CycleBar selection={selection} timeZone={timeZone} retentionDays={getConfig().retentionDays} />

      {selected.kind === "summary" && summaries.length > 0 ? (
        <ArchivedCycleView
          summaries={summaries}
          historyByProvider={historyByProvider}
          historyContext={historyContext}
          timeZone={timeZone}
          selectedStartMs={selected.startMs}
          pastCycle
          costEstimate={costEstimate}
        />
      ) : providers.length > 0 ? (
        <DashboardView
          providers={providers}
          historyByProvider={historyByProvider}
          historyContext={historyContext}
          pastCycle={selected.kind !== "current"}
        />
      ) : (
        <section aria-labelledby="no-providers-heading" className="mt-12 max-w-xl">
          <h2 id="no-providers-heading" className="text-xl font-medium">
            {tDashboard("no_machines_yet")}
          </h2>
          <p className="mt-3 text-ink-2">
            {tDashboard.rich("setup_machines", {
              link: (chunks) => (
                <Link
                  href="/setup"
                  className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink-3"
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </section>
      )}

      <footer className="mt-16 flex flex-wrap items-center gap-3 text-sm text-ink-3">
        <span>{t("credit_made_by")}</span>
        <a
          href="https://github.com/snktibor"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-md border border-rule px-2.5 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
        >
          <GitHubIcon />
          snktibor
        </a>
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="hover:text-ink-2">
          {t("footer_source")}
        </a>
        <a href={`${REPO_URL}/releases`} target="_blank" rel="noreferrer" className="hover:text-ink-2">
          {t("footer_version", { version })}
        </a>
      </footer>
    </div>
  );
}
