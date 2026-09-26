import { getLocale, getTranslations } from "next-intl/server";
import { logout } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { DashboardView } from "@/components/dashboard-view";
import { DownloadIcon, ExportIcon, GitHubIcon } from "@/components/icons";
import { SettingsDialog } from "@/components/settings-dialog";
import { Link } from "@/i18n/routing";
import type { ProviderDashboardModel } from "@/lib/dashboard";
import { isDemoMode } from "@/lib/demo/mode";
import { formatClock } from "@/lib/format";
import type { CycleSummary } from "@/lib/history";
import type { Translator } from "@/lib/i18n";
import type { SettingsView } from "@/lib/settings";
import { version } from "@/package.json";

const REPO_URL = "https://github.com/snktibor/usageratio";

/**
 * Plain links, not a fetch: the browser's own download UI handles the
 * `Content-Disposition: attachment` response (see app/api/export/route.ts).
 * Exports every visible provider's current cycle; a specific provider or the
 * previous cycle is reachable through the same endpoint's query parameters.
 * Allowed in demo mode too: it only reads, never writes.
 */
function ExportMenu({ t }: { t: Translator<"HomePage"> }) {
  return (
    <details className="relative">
      <summary className="flex list-none items-center gap-2 rounded-md border border-rule px-2.5 py-1.5 text-ink-2 transition-colors marker:content-none hover:border-ink-3 hover:text-ink sm:px-3 [&::-webkit-details-marker]:hidden">
        <ExportIcon />
        <span className="sr-only sm:not-sr-only">{t("export")}</span>
      </summary>
      <div className="absolute right-0 z-10 mt-2 w-40 rounded-md border border-rule bg-raised p-1.5 text-sm shadow-lg">
        <a
          href="/api/export?format=csv&cycle=current"
          className="block rounded px-2.5 py-1.5 text-ink-2 transition-colors hover:bg-page hover:text-ink"
        >
          {t("export_csv")}
        </a>
        <a
          href="/api/export?format=json&cycle=current"
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
  settings,
  historyByProvider,
}: {
  providers: ProviderDashboardModel[];
  settings: SettingsView;
  historyByProvider: Record<string, CycleSummary[]>;
}) {
  const locale = await getLocale();
  const t = await getTranslations("HomePage");
  const tDashboard = await getTranslations("Dashboard");
  // A fresh install has no provider yet: no model, only the settings' time zone.
  const model = providers[0]?.dashboard;
  const refreshedAt = formatClock(model?.generatedAt ?? Date.now(), model?.timeZone ?? settings.timeZone, locale);

  return (
    <div className="mx-auto w-full max-w-4xl px-5 pb-16 pt-6 sm:px-8 sm:pt-8">
      <AutoRefresh />

      <header className="flex items-center justify-between gap-4">
        <p className="text-lg font-medium tracking-tight">usageratio</p>
        <div className="flex items-center gap-3 text-sm text-ink-3 sm:gap-4">
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
          {providers.length > 0 && <ExportMenu t={t} />}
          <SettingsDialog view={settings} />
          {!isDemoMode() && (
            <form action={logout}>
              <button
                type="submit"
                className="rounded-md border border-rule px-3 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
              >
                {t("dashboard_logout")}
              </button>
            </form>
          )}
        </div>
      </header>

      {providers.length > 0 ? (
        <DashboardView providers={providers} historyByProvider={historyByProvider} />
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

      <footer className="mt-16 flex items-center gap-3 text-sm text-ink-3">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-md border border-rule px-2.5 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
        >
          <GitHubIcon />
          {t("footer_source")}
        </a>
        <a href={`${REPO_URL}/releases`} target="_blank" rel="noreferrer" className="hover:text-ink-2">
          {t("footer_version", { version })}
        </a>
      </footer>
    </div>
  );
}
