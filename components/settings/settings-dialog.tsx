"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { SlidersIcon } from "@/components/icons";
import { SettingsForm } from "@/components/settings/settings-form";
import type { SettingsView } from "@/lib/settings";

/**
 * The header's settings button and the modal it opens. The form only exists
 * while the dialog is open, so every opening starts from the freshly rendered
 * settings, and a background refresh never overwrites what is being typed.
 */
export function SettingsDialog({ view }: { view: SettingsView }) {
  const t = useTranslations("Settings");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const titleId = useId();

  // Opened after the form has rendered, so the browser finds its first control to focus.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="flex items-center gap-2 rounded-md border border-rule px-2.5 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink sm:px-3"
      >
        <SlidersIcon />
        <span className="sr-only sm:not-sr-only">{t("settings_title")}</span>
      </button>

      <dialog
        ref={dialogRef}
        // The token section's own dialogs sit inside this one, and React bubbles their close events here.
        onClose={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        aria-labelledby={titleId}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-xl border border-rule bg-raised text-base text-ink shadow-2xl backdrop:bg-black/60"
      >
        {open && <SettingsForm view={view} titleId={titleId} onClose={() => dialogRef.current?.close()} />}
      </dialog>
    </>
  );
}
