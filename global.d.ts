import type { locales } from "./i18n/locales.generated";
import type en from "./messages/en.json";

/**
 * Typed messages: every `t("key")`, its ICU arguments and every `locale`
 * value are checked against messages/en.json and the generated locale list.
 * A key that exists in no message file is a compile error, not a runtime
 * fallback string.
 */
declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof locales)[number];
    Messages: typeof en;
  }
}
