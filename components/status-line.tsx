import { AlertTriangleIcon, CheckCircleIcon, InfoCircleIcon, StopCircleIcon } from "@/components/icons";
import type { StatusTone } from "@/lib/api-token";

/** A short status sentence behind its icon: the tone is never told by colour alone. */
export function StatusLine({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  const icon =
    tone === "good" ? (
      <CheckCircleIcon className="mt-0.5 shrink-0 text-good" />
    ) : tone === "warning" ? (
      <AlertTriangleIcon className="mt-0.5 shrink-0 text-warning" />
    ) : tone === "problem" ? (
      <StopCircleIcon className="mt-0.5 shrink-0 text-critical" />
    ) : (
      <InfoCircleIcon className="mt-0.5 shrink-0 text-ink-3" />
    );
  return (
    <p className="flex items-start gap-2 text-sm text-ink-2">
      {icon}
      <span>{children}</span>
    </p>
  );
}
