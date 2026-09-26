import type { createTranslator, Messages } from "next-intl";

/**
 * The translator of one namespace, for helpers and child components that get
 * the translator handed down from the component that called
 * `useTranslations(namespace)`: `statusLabel(translate: Translator<"Widgets">)`.
 */
export type Translator<Namespace extends keyof Messages> = ReturnType<typeof createTranslator<Messages, Namespace>>;

export type MessageNamespace = keyof Messages;
