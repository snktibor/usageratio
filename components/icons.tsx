/** 16px status glyphs. Status is never colour alone: each one ships next to a text label. */

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
