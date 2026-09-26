import { Link } from "@/i18n/routing";
import { logout } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { DashboardView } from "@/components/dashboard-view";
import { DownloadIcon, GitHubIcon } from "@/components/icons";
import { SettingsDialog } from "@/components/settings-dialog";
import type { ProviderDashboardModel } from "@/lib/dashboard";
import { formatClock } from "@/lib/format";
import type { SettingsView } from "@/lib/settings";
import { getTranslations, getLocale } from "next-intl/server";

export async function Dashboard({
  providers,
  settings,
}: {
  providers: ProviderDashboardModel[];
  settings: SettingsView;
}) {
  const locale = await getLocale();
  const t = await getTranslations("HomePage");
  const model = providers[0]!.dashboard;
  const refreshedAt = formatClock(model.generatedAt, model.timeZone, locale);

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
          <SettingsDialog view={settings} />
          <form action={logout}>
            <button
              type="submit"
              className="rounded-md border border-rule px-3 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
            >
              {t("dashboard_logout")}
            </button>
          </form>
        </div>
      </header>

      <DashboardView providers={providers} />

      <footer className="mt-16 flex items-center gap-3 text-sm text-ink-3">
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
      </footer>
    </div>
  );
}
