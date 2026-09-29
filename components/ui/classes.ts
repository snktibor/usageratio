/**
 * Class strings shared by more than one settings control, kept in one place
 * so the panel and its nested dialogs stay visually consistent.
 */

export const FIELD =
  "rounded-md border border-rule bg-page px-3 py-2 text-ink placeholder:text-ink-3 disabled:opacity-50";

export const QUIET_BUTTON =
  "rounded-md border border-rule px-3 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40";

export const PRIMARY_BUTTON =
  "rounded-md bg-ink px-5 py-1.5 font-medium text-page transition-opacity hover:opacity-90 disabled:opacity-40";

/** A `<dialog>` opened from the settings page: same chrome, its own width and padding. */
export const NESTED_DIALOG =
  "m-auto max-h-[calc(100dvh-2rem)] rounded-xl border border-rule bg-raised text-base text-ink shadow-2xl backdrop:bg-black/60";
