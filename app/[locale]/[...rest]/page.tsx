import { notFound } from "next/navigation";

/**
 * Every path under a locale that no page claims ends here, so the localized
 * not-found.tsx renders instead of Next's default document (the recipe for
 * a root layout with a dynamic segment; `global-not-found` is still experimental).
 */
export default function CatchAllPage(): never {
  notFound();
}
