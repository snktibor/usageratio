/**
 * 16px glyphs. Status is never colour alone: each status icon ships next to a
 * text label, and an action icon standing alone gets an aria-label on its button.
 */

interface IconProps {
  className?: string;
}

function Glyph({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export function CheckCircleIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.4 8.2 1.8 1.8 3.5-3.8" />
    </Glyph>
  );
}

export function AlertTriangleIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M8 2.2 14.3 13H1.7L8 2.2Z" />
      <path d="M8 6.6v3" />
      <path d="M8 11.4v.1" />
    </Glyph>
  );
}

export function StopCircleIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.9 5.9 4.2 4.2m0-4.2-4.2 4.2" />
    </Glyph>
  );
}

export function InfoCircleIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.4v3.6" />
      <path d="M8 5v.1" />
    </Glyph>
  );
}

export function ClockIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.2 1.4" />
    </Glyph>
  );
}

export function MoonIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />
    </Glyph>
  );
}

export function SlidersIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M2.2 4.6h5.5m3.6 0h2.5M2.2 11.4h2.5m3.6 0h5.5" />
      <circle cx="9.5" cy="4.6" r="1.8" />
      <circle cx="6.5" cy="11.4" r="1.8" />
    </Glyph>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="m3.5 8.4 2.9 2.9 6.1-6.6" />
    </Glyph>
  );
}

export function XIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="m4 4 8 8m0-8-8 8" />
    </Glyph>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </Glyph>
  );
}

export function DownloadIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M8 2.4v7.4m0 0 3-3m-3 3-3-3" />
      <path d="M2.6 10.6v1.6c0 .7.5 1.2 1.2 1.2h8.4c.7 0 1.2-.5 1.2-1.2v-1.6" />
    </Glyph>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <rect x="5.4" y="5.4" width="8" height="8" rx="1.4" />
      <path d="M10.6 5.4V3.8c0-.8-.6-1.4-1.4-1.4H3.8c-.8 0-1.4.6-1.4 1.4v5.4c0 .8.6 1.4 1.4 1.4h1.6" />
    </Glyph>
  );
}

export function ArrowLeftIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M13 8H3.4m0 0 4-4m-4 4 4 4" />
    </Glyph>
  );
}

export function KeyIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="5.4" cy="10.6" r="2.8" />
      <path d="m7.4 8.6 5.4-5.4m-2 2 1.6 1.6m-3.2-.1 1.2 1.2" />
    </Glyph>
  );
}

export function HistoryIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M2.4 8a5.6 5.6 0 1 0 1.7-4" />
      <path d="M2.2 2.6v2.6h2.6" />
      <path d="M8 5.2V8l2 1.3" />
    </Glyph>
  );
}

/** The GitHub mark: a solid logo, so it breaks from `Glyph`'s stroke-only style. */
export function GitHubIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
