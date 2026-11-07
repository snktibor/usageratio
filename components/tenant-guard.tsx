"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { QUIET_BUTTON } from "@/components/ui/classes";
import { TENANT_HEADER } from "@/lib/tenant-header";

/**
 * The browser half of the stale-tab guard (lib/tenant-header.ts): every
 * request this page sends to the app's own API that changes something names
 * the workspace the page was rendered for. When the server answers 409
 * tenant_changed (the workspace was switched in another tab), a banner says
 * so instead of the change landing anywhere.
 *
 * Installed once per page load by wrapping `fetch`, so no call site can
 * forget the header; only same-origin `/api/` requests are touched.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
let current: string | null = null;
let installed = false;
let onChanged: (() => void) | null = null;

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function isOwnApi(input: RequestInfo | URL): boolean {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  return url.origin === window.location.origin && url.pathname.startsWith("/api/");
}

function install(): void {
  if (installed) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    if (!current || SAFE_METHODS.has(methodOf(input, init)) || !isOwnApi(input)) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(TENANT_HEADER, current);
    const response = await original(input, { ...init, headers });
    if (response.status === 409) {
      const error = (
        (await response
          .clone()
          .json()
          .catch(() => null)) as { error?: string } | null
      )?.error;
      if (error === "tenant_changed") onChanged?.();
    }
    return response;
  };
}

export function TenantGuard({ tenantId }: { tenantId: string }) {
  const t = useTranslations("TenantGuard");
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    install();
    current = tenantId;
    onChanged = () => setChanged(true);
    return () => {
      onChanged = null;
    };
  }, [tenantId]);

  if (!changed) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-50 flex flex-wrap items-center justify-center gap-3 border-b border-rule bg-raised px-4 py-3 text-sm text-ink shadow-lg"
    >
      <span>{t("changed")}</span>
      <button type="button" className={QUIET_BUTTON} onClick={() => window.location.reload()}>
        {t("reload")}
      </button>
    </div>
  );
}
