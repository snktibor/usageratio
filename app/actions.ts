"use server";

import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/routing";
import { attemptLogin, endSession, type LoginResult } from "@/lib/auth";
import { log } from "@/lib/log";
import { StorageNotConfiguredError } from "@/lib/redis";

export interface LoginState {
  error: string | null;
}

/** Where a successful login may continue: the pages that show the PIN form. Anything else goes home. */
const AFTER_LOGIN = new Set(["/", "/setup"]);

/** Form action of the PIN screen. Returns an error to display, or redirects to the page that asked (`next`). */
export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const pin = String(formData.get("pin") ?? "").trim();

  let result: LoginResult;
  try {
    result = await attemptLogin(pin);
  } catch (error) {
    log.error("login.store_unreachable", { err: error });
    if (error instanceof StorageNotConfiguredError) {
      return {
        error:
          "Az adattár nincs bekötve: hiányzik a KV_REST_API_URL és a KV_REST_API_TOKEN. " +
          "Kösd a Redis adatbázist a Vercel-projekthez, majd telepítsd újra.",
      };
    }
    return { error: "Az adattár most nem érhető el, ezért a belépés sem. Próbáld újra kicsit később." };
  }

  if (!result.ok) {
    switch (result.reason) {
      case "malformed":
        return { error: "A PIN-kód pontosan 5 számjegy." };
      case "misconfigured":
        return { error: "A szerveren nincs érvényes DASHBOARD_PIN beállítva (5 számjegy kell)." };
      case "rate_limited": {
        const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
        return { error: `Túl sok próbálkozás. Próbáld újra ${minutes} perc múlva.` };
      }
      case "invalid":
        return {
          error:
            result.attemptsLeft > 0
              ? `Hibás PIN-kód. Még ${result.attemptsLeft} próbálkozásod van.`
              : "Hibás PIN-kód. Elfogytak a próbálkozások, 15 perc múlva próbálhatod újra.",
        };
    }
  }

  const next = String(formData.get("next") ?? "/");
  const locale = await getLocale();
  return redirect({ href: AFTER_LOGIN.has(next) ? next : "/", locale });
}

export async function logout(): Promise<void> {
  try {
    await endSession();
  } catch (error) {
    // The cookie is already cleared; a stale Redis key simply expires.
    log.error("logout.store_unreachable", { err: error });
  }
  const locale = await getLocale();
  return redirect({ href: "/", locale });
}
