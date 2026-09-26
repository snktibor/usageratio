import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { routing } from "@/i18n/routing";

// One Open Graph image for every locale: the tagline below is brand copy,
// not translated UI text, so a single English image covers all of them.
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export const alt = "usageratio — every machine's AI token budget, in one dashboard";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const COLORS = {
  page: "#1a1a19",
  rule: "#383835",
  ink: "#f4f3ef",
  ink2: "#c3c2b7",
  // ink-3 (#9a9891) at 35% opacity, for the mark's plate outline below.
  ink3Outline: "rgba(154, 152, 145, 0.35)",
};

// The fonts don't depend on request data, so read them once at module scope
// (see "Predictable values" in the opengraph-image docs).
const fontsPromise = Promise.all([
  readFile(join(process.cwd(), "assets/fonts/InstrumentSans-Bold.ttf")),
  readFile(join(process.cwd(), "assets/fonts/InstrumentSans-SemiBold.ttf")),
  readFile(join(process.cwd(), "assets/fonts/InstrumentSans-Regular.ttf")),
]);

/** The meter mark, matching app/icon.svg's proportions, as flex divs (ImageResponse can't take arbitrary <svg>). */
function Mark({ size }: { size: number }) {
  const k = size / 32;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 7 * k,
        background: COLORS.page,
        border: `${Math.max(1, 1 * k)}px solid ${COLORS.ink3Outline}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ position: "relative", width: 20 * k, height: 14 * k, display: "flex" }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 4 * k,
            width: 20 * k,
            height: 6 * k,
            background: COLORS.rule,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 4 * k,
            width: 12 * k,
            height: 6 * k,
            background: COLORS.ink,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 14 * k,
            top: 0,
            width: 2 * k,
            height: 14 * k,
            background: COLORS.ink,
          }}
        />
      </div>
    </div>
  );
}

export default async function Image() {
  const [bold, semibold, regular] = await fontsPromise;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        background: COLORS.page,
        padding: "64px 80px",
        fontFamily: "Instrument Sans",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", flexDirection: "column" }}>
        <Mark size={72} />
        <div
          style={{
            display: "flex",
            marginTop: 36,
            fontSize: 132,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            lineHeight: 1,
            color: COLORS.ink,
          }}
        >
          usageratio
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 24,
            fontSize: 32,
            fontWeight: 400,
            color: COLORS.ink2,
          }}
        >
          Every machine&apos;s AI token budget, in one dashboard.
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", marginTop: 56 }}>
          <div style={{ display: "flex", flexDirection: "column", width: 340 }}>
            <div style={{ display: "flex", fontSize: 28, fontWeight: 600, color: COLORS.ink, marginBottom: 12 }}>
              62.5%
            </div>
            <div style={{ position: "relative", width: 340, height: 16, display: "flex" }}>
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 340,
                  height: 16,
                  borderRadius: 4,
                  background: COLORS.rule,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 212,
                  height: 16,
                  borderRadius: 4,
                  background: COLORS.ink,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 238,
                  top: -6,
                  width: 3,
                  height: 28,
                  background: COLORS.ink,
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Instrument Sans", data: bold, weight: 700, style: "normal" },
        { name: "Instrument Sans", data: semibold, weight: 600, style: "normal" },
        { name: "Instrument Sans", data: regular, weight: 400, style: "normal" },
      ],
    },
  );
}
