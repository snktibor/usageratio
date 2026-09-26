"use client";

import { useTranslations } from "next-intl";
import { INSTALL_ROUTES, type InstallRoute } from "@/lib/setup";

export function tabId(tabsId: string, route: InstallRoute): string {
  return `${tabsId}-tab-${route}`;
}

export function panelId(tabsId: string, route: InstallRoute): string {
  return `${tabsId}-panel-${route}`;
}

/** The three install routes as an ARIA tablist; arrow keys move the selection like a native tab strip. */
export function RouteTabs({
  tabsId,
  value,
  onChange,
}: {
  tabsId: string;
  value: InstallRoute;
  onChange: (route: InstallRoute) => void;
}) {
  const t = useTranslations("Setup");
  const move = (delta: 1 | -1) => {
    const index = INSTALL_ROUTES.indexOf(value);
    const next = INSTALL_ROUTES[(index + delta + INSTALL_ROUTES.length) % INSTALL_ROUTES.length]!;
    onChange(next);
    document.getElementById(tabId(tabsId, next))?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={t("install_method")}
      className="flex flex-wrap gap-1 border-b border-rule"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {INSTALL_ROUTES.map((route) => (
        <button
          key={route}
          type="button"
          role="tab"
          id={tabId(tabsId, route)}
          aria-selected={value === route}
          aria-controls={panelId(tabsId, route)}
          tabIndex={value === route ? 0 : -1}
          onClick={() => onChange(route)}
          className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
            value === route ? "border-ink text-ink" : "border-transparent text-ink-2 hover:text-ink"
          }`}
        >
          {t(`route_${route}`)}
        </button>
      ))}
    </div>
  );
}
