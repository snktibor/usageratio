import { securityTxt } from "@/lib/security-txt";

/** GET /.well-known/security.txt — RFC 9116; outside proxy.ts's matcher (the path has a dot). */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(securityTxt(new Date()), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
}
