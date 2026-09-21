"use server";

import { redirect } from "next/navigation";
import { attemptLogin, endSession } from "@/lib/auth";
import { StorageNotConfiguredError } from "@/lib/redis";

export interface LoginState {
  error: string | null;
}

/** Form action of the PIN screen. Returns an error to display, or redirects into the dashboard. */
export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const pin = String(formData.get("pin") ?? "").trim();

  let result;
  try {
    result = await attemptLogin(pin);
  } catch (error) {
    console.error("[usageratio] Login could not reach the store:", error);
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

  redirect("/");
}

export async function logout(): Promise<void> {
  try {
    await endSession();
  } catch (error) {
    // The cookie is already cleared; a stale Redis key simply expires.
    console.error("[usageratio] Logout could not reach the store:", error);
  }
  redirect("/");
}
