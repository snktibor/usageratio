"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { StatusLine } from "@/components/status-line";
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from "@/components/ui/classes";
import { When } from "@/components/ui/when";
import { Link } from "@/i18n/routing";
import type { AdminOverview } from "@/lib/admin";
import type { SignupCodeEntry } from "@/lib/signup-codes";
import { DEFAULT_TENANT } from "@/lib/tenant-id";

/**
 * The instance admin's page: counts per tenant (never a tenant's data), disabling a tenant, and
 * sign-up links. A new link is shown once: only its code's hash is kept.
 */
export function AdminView({ overview, codes }: { overview: AdminOverview; codes: SignupCodeEntry[] }) {
  const t = useTranslations("Admin");
  const [rows, setRows] = useState(overview.rows);
  const [codeList, setCodeList] = useState(codes);
  const [newLink, setNewLink] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function setStatus(tenantId: string, status: "active" | "disabled") {
    setProblem(null);
    const response = await fetch(`/api/admin/tenants/${tenantId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }).catch(() => null);
    if (!response?.ok) return setProblem(t("action_failed"));
    setRows((current) => current.map((row) => (row.tenantId === tenantId ? { ...row, status } : row)));
  }

  async function createCode() {
    setProblem(null);
    const response = await fetch("/api/admin/signup-codes", { method: "POST" }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { url?: string; entry?: SignupCodeEntry } | null;
    if (!response?.ok || !body?.url || !body.entry) return setProblem(t("action_failed"));
    setNewLink(body.url);
    const { entry } = body;
    setCodeList((current) => [entry, ...current]);
  }

  async function revoke(id: string) {
    setProblem(null);
    const response = await fetch(`/api/admin/signup-codes/${id}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) return setProblem(t("action_failed"));
    setCodeList((current) => current.filter((code) => code.id !== id));
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-5 pb-16 pt-6 sm:px-8 sm:pt-8">
      <header className="flex items-center justify-between gap-4">
        <Link href="/" className="text-lg font-medium tracking-tight">
          usageratio
        </Link>
        <Link href="/account" className={QUIET_BUTTON}>
          {t("account_link")}
        </Link>
      </header>

      <h1 className="mt-10 text-3xl font-semibold tracking-tight">{t("heading")}</h1>
      <p className="mt-2 max-w-2xl text-ink-2">{t("description")}</p>
      <p className="mt-4 text-sm text-ink-2">
        {t("counts", {
          users: overview.usersWithWorkspace,
          total: overview.tenants.total,
          disabled: rows.filter((row) => row.status === "disabled").length,
        })}
      </p>
      <div aria-live="polite" className="mt-3">
        {problem && <StatusLine tone="problem">{problem}</StatusLine>}
      </div>

      <section className="mt-8 overflow-x-auto">
        <table className="w-full min-w-[48rem] text-left text-sm">
          <thead className="text-ink-3">
            <tr>
              <th className="py-2 pr-3 font-normal">{t("col_tenant")}</th>
              <th className="py-2 pr-3 font-normal">{t("col_owners")}</th>
              <th className="py-2 pr-3 font-normal">{t("col_members")}</th>
              <th className="py-2 pr-3 font-normal">{t("col_machines")}</th>
              <th className="py-2 pr-3 font-normal">{t("col_tokens")}</th>
              <th className="py-2 pr-3 font-normal">{t("col_keys")}</th>
              <th className="py-2 pr-3 font-normal">{t("col_last_report")}</th>
              <th className="py-2 font-normal">{t("col_status")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map((row) => (
              <tr key={row.tenantId}>
                <td className="py-2 pr-3 font-mono text-xs">{row.tenantId}</td>
                <td className="py-2 pr-3">{row.owners.join(", ") || "—"}</td>
                <td className="py-2 pr-3">{row.members}</td>
                <td className="py-2 pr-3">{row.machines}</td>
                <td className="py-2 pr-3">{row.tokens}</td>
                <td className="py-2 pr-3">{row.keys}</td>
                <td className="py-2 pr-3">
                  <When ms={row.lastReportAt} />
                </td>
                <td className="py-2">
                  {row.tenantId === DEFAULT_TENANT ? (
                    t("status_active")
                  ) : row.status === "deleting" ? (
                    t("status_deleting")
                  ) : (
                    <button
                      type="button"
                      className={QUIET_BUTTON}
                      onClick={() => setStatus(row.tenantId, row.status === "active" ? "disabled" : "active")}
                    >
                      {row.status === "active" ? t("disable") : t("enable")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-medium">{t("codes_heading")}</h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-2">{t("codes_description")}</p>
        <button type="button" onClick={createCode} className={`mt-4 ${PRIMARY_BUTTON}`}>
          {t("create_code")}
        </button>
        {newLink && (
          <div className="mt-4 max-w-2xl space-y-2">
            <p className="text-sm text-ink">{t("new_code_once")}</p>
            <input
              readOnly
              value={newLink}
              className={`w-full font-mono text-xs ${FIELD}`}
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
        )}
        <ul className="mt-6 divide-y divide-rule rounded-md border border-rule text-sm">
          {codeList.map((code) => (
            <li key={code.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
              <span className="font-mono text-xs">{code.id}</span>
              <span className="text-ink-2">
                {code.usedAt ? (
                  <>
                    {t("code_used")} <When ms={code.usedAt} />
                  </>
                ) : code.expiresAt < Date.now() ? (
                  t("code_expired")
                ) : (
                  <>
                    {t("code_expires")} <When ms={code.expiresAt} />
                  </>
                )}
              </span>
              {!code.usedAt && code.expiresAt >= Date.now() && (
                <button type="button" onClick={() => revoke(code.id)} className={QUIET_BUTTON}>
                  {t("revoke")}
                </button>
              )}
            </li>
          ))}
          {codeList.length === 0 && <li className="px-4 py-3 text-ink-2">{t("no_codes")}</li>}
        </ul>
      </section>
    </main>
  );
}
