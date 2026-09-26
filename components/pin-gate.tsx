import { getTranslations } from "next-intl/server";
import { LanguageSwitcher } from "@/components/language-switcher";
import { PinForm } from "@/components/pin-form";
import { autoSubmitLength, pinShape } from "@/lib/auth";

/**
 * The only thing an unauthenticated visitor ever receives: no usage data is rendered here.
 * `next`: the page to return to after a successful login (default: the dashboard).
 */
export async function PinGate({ next = "/" }: { next?: string }) {
  const t = await getTranslations("HomePage");
  const { numeric } = pinShape();

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pt-6 sm:px-8 sm:pt-8">
      <div className="flex items-center justify-between gap-4">
        <p className="text-lg font-medium tracking-tight">usageratio</p>
        <LanguageSwitcher />
      </div>

      <div className="mt-[18vh]">
        <h1 id="pin-heading" className="text-4xl font-semibold tracking-tight sm:text-5xl">
          {t("pin_heading")}
        </h1>
        <p className="mt-4 max-w-md text-ink-2">{t("pin_description")}</p>
        <PinForm labelledBy="pin-heading" next={next} numeric={numeric} autoSubmitLength={autoSubmitLength()} />
      </div>
    </main>
  );
}
