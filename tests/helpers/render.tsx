import { type RenderOptions, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import en from "@/messages/en.json";

/** Renders `ui` the way a page does: inside the next-intl provider with the English messages. */
export function renderWithIntl(ui: ReactElement, options: RenderOptions & { locale?: string } = {}) {
  const { locale = "en", ...rest } = options;
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <NextIntlClientProvider locale={locale} messages={en} timeZone="Europe/Budapest">
      {children}
    </NextIntlClientProvider>
  );
  return render(ui, { wrapper: Wrapper, ...rest });
}
