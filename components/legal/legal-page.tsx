import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Link } from "@/i18n/routing";
import { LEGAL_UPDATED, type LegalOperator, type LegalSpec, legalOperator } from "@/lib/legal";

/** One block of a section: a paragraph, or a bulleted list of items. */
export type LegalBlock = ReactNode | { items: ReactNode[] };

export interface LegalSection {
  id: string;
  title: string;
  blocks: LegalBlock[];
}

type Suffix<B> = B extends readonly (infer Item)[] ? Item : B;
type SectionKeys<S> = S extends { readonly id: infer Id extends string; readonly blocks: readonly (infer B)[] }
  ? `${Id}_${Suffix<B> & string}`
  : never;

/** Every block key of `S`. */
export type LegalBlockKey<S extends LegalSpec> = SectionKeys<S[number]>;
/** Every section title key of `S`. */
export type LegalTitleKey<S extends LegalSpec> = `${S[number]["id"]}_title`;

/**
 * The rich-text tags every legal message may use: <b>, <code>, <mail> (the
 * contact address) and links to the two documents and to the outside pages
 * they cite.
 */
export function legalRich(operator: LegalOperator) {
  const external = (href: string) => (chunks: ReactNode) => (
    <a href={href} className="underline underline-offset-2 hover:text-ink" rel="noopener noreferrer" target="_blank">
      {chunks}
    </a>
  );
  return {
    name: operator.name,
    email: operator.email,
    b: (chunks: ReactNode) => <strong className="font-medium text-ink">{chunks}</strong>,
    code: (chunks: ReactNode) => <code className="font-mono text-[0.9em] text-ink">{chunks}</code>,
    mail: (chunks: ReactNode) => (
      <a href={`mailto:${operator.email}`} className="underline underline-offset-2 hover:text-ink">
        {chunks}
      </a>
    ),
    privacy: (chunks: ReactNode) => (
      <Link href="/privacy" className="underline underline-offset-2 hover:text-ink">
        {chunks}
      </Link>
    ),
    naih: external("https://naih.hu"),
    vercel: external("https://vercel.com/legal/privacy-notice"),
    upstash: external("https://upstash.com/trust/privacy"),
    cloudflare: external("https://www.cloudflare.com/privacypolicy/"),
    github: external("https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement"),
  };
}

/** Builds the sections of `spec`: `translate` renders a block's key, `title` a section's title key. */
export function legalSections<S extends LegalSpec>(
  spec: S,
  translate: (key: LegalBlockKey<S>) => ReactNode,
  title: (key: LegalTitleKey<S>) => string,
): LegalSection[] {
  const block = (id: string, suffix: string) => translate(`${id}_${suffix}` as LegalBlockKey<S>);
  return spec.map(({ id, blocks }) => ({
    id,
    title: title(`${id}_title` as LegalTitleKey<S>),
    blocks: blocks.map((entry) =>
      typeof entry === "string" ? block(id, entry) : { items: entry.map((item) => block(id, item)) },
    ),
  }));
}

function isList(block: LegalBlock): block is { items: ReactNode[] } {
  return typeof block === "object" && block !== null && "items" in block;
}

/** The page frame of the privacy notice and the terms of use. */
export async function LegalPage({
  heading,
  intro,
  sections,
}: {
  heading: string;
  intro: ReactNode;
  sections: LegalSection[];
}) {
  const t = await getTranslations("Legal");
  const format = await getFormatter();
  const updated = format.dateTime(new Date(`${LEGAL_UPDATED}T12:00:00Z`), { dateStyle: "long", timeZone: "UTC" });

  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-20 pt-6 sm:px-8 sm:pt-8">
      <header className="flex items-center justify-between gap-4">
        <Link href="/" className="text-lg font-medium tracking-tight">
          usageratio
        </Link>
        <LanguageSwitcher />
      </header>

      <article className="mt-12">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{heading}</h1>
        <p className="mt-3 text-sm text-ink-3">{t("updated", { date: updated })}</p>
        <p className="mt-6 text-ink-2">{intro}</p>

        {sections.map((section) => (
          <section key={section.id} aria-labelledby={`legal-${section.id}`} className="mt-10">
            <h2 id={`legal-${section.id}`} className="text-lg font-medium tracking-tight">
              {section.title}
            </h2>
            <div className="mt-3 space-y-3 text-[0.95rem] leading-relaxed text-ink-2">
              {section.blocks.map((block, index) =>
                isList(block) ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are a fixed list
                  <ul key={index} className="list-disc space-y-2 pl-5 marker:text-ink-3">
                    {block.items.map((item, itemIndex) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the items are a fixed list
                      <li key={itemIndex}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are a fixed list
                  <p key={index}>{block}</p>
                ),
              )}
            </div>
          </section>
        ))}
      </article>

      <LegalLinks className="mt-16 border-t border-hairline pt-6" />
    </main>
  );
}

/** "Privacy · Terms", for the sign-in screens and the account page; nothing on an instance without an operator. */
export async function LegalLinks({ className = "" }: { className?: string }) {
  if (!legalOperator()) return null;
  const t = await getTranslations("Legal");
  return (
    <nav aria-label={t("nav_label")} className={`flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-3 ${className}`}>
      <Link href="/privacy" className="hover:text-ink">
        {t("privacy_link")}
      </Link>
      <Link href="/terms" className="hover:text-ink">
        {t("terms_link")}
      </Link>
    </nav>
  );
}

/** "By signing in you accept the terms…", under a sign-in button; nothing on an instance without an operator. */
export async function LegalConsent({ className = "" }: { className?: string }) {
  if (!legalOperator()) return null;
  const t = await getTranslations("Legal");
  const link = (href: "/privacy" | "/terms") => (chunks: ReactNode) => (
    <Link href={href} className="underline underline-offset-2 hover:text-ink">
      {chunks}
    </Link>
  );
  return (
    <p className={`max-w-md text-sm text-ink-3 ${className}`}>
      {t.rich("consent", { terms: link("/terms"), privacy: link("/privacy") })}
    </p>
  );
}
