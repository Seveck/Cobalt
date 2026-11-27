import { resolvePreviewTokens } from "@/lib/themeEngine";
import type { ThemeManifest } from "@/types/contracts";

interface ThemeMiniPreviewProps {
  manifest: ThemeManifest;
}

const SAMPLE_NODES: ReadonlyArray<{ x: number; y: number; r: number; key: "core" | "reusable" | "node" | "c1" | "c2" | "c3" | "pulse" }> = [
  { x: 24, y: 26, r: 2.8, key: "c1" },
  { x: 52, y: 18, r: 3.1, key: "core" },
  { x: 76, y: 34, r: 2.5, key: "c2" },
  { x: 34, y: 58, r: 2.4, key: "reusable" },
  { x: 64, y: 66, r: 2.6, key: "c3" },
  { x: 18, y: 74, r: 2.1, key: "node" },
  { x: 54, y: 44, r: 3.4, key: "pulse" },
];

/**
 * Live miniature app-chrome + 3D brain preview painted directly from the
 * theme's generated OKLCH UI tokens and 3D palette.
 */
export function ThemeMiniPreview({ manifest }: ThemeMiniPreviewProps) {
  const tokens = resolvePreviewTokens(manifest);
  const rCard = Math.min(tokens.radiusPx, 8);
  const rSm = Math.min(tokens.radiusSmPx, 5);
  const cats = Object.values(manifest.palette.category_colors).filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  const nodeColor = (key: (typeof SAMPLE_NODES)[number]["key"]): string => {
    switch (key) {
      case "core":
        return manifest.palette.core_pin;
      case "reusable":
        return manifest.palette.reusable;
      case "c1":
        return cats[0] ?? manifest.palette.node;
      case "c2":
        return cats[1] ?? manifest.palette.node;
      case "c3":
        return cats[2] ?? manifest.palette.node;
      case "pulse":
        return manifest.palette.pulse_read;
      default:
        return manifest.palette.node;
    }
  };

  return (
    <div
      aria-hidden="true"
      className="relative flex h-36 w-full overflow-hidden border-b border-rule select-none"
      style={{
        backgroundColor: tokens.void,
        color: tokens.bone,
      }}
    >
      {/* Mini sidebar */}
      <div
        className="flex w-16 shrink-0 flex-col gap-1.5 p-2"
        style={{
          backgroundColor: tokens.sidebar,
          borderRight: `1px solid ${tokens.rule}`,
        }}
      >
        <div className="mb-1 flex items-center gap-1.5">
          <span
            className="h-3 w-3 shrink-0"
            style={{
              backgroundColor: tokens.cobalt,
              borderRadius: `${Math.min(rSm + 1, 4)}px`,
            }}
          />
          <span
            className="h-1.5 w-8 rounded-full"
            style={{ backgroundColor: tokens.bone, opacity: 0.85 }}
          />
        </div>

        {/* Active nav item */}
        <div
          className="flex items-center gap-1.5 px-1.5 py-1"
          style={{
            backgroundColor: tokens.cobaltWash,
            borderLeft: `2px solid ${tokens.cobalt}`,
            borderRadius: `${rSm}px`,
          }}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: tokens.cobaltInk }}
          />
          <span
            className="h-1 w-7 rounded-full"
            style={{ backgroundColor: tokens.bone, opacity: 0.9 }}
          />
        </div>

        {/* Inactive nav items */}
        {[8, 6, 7].map((w, idx) => (
          <div key={idx} className="flex items-center gap-1.5 px-1.5 py-0.5">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: tokens.boneSubtle, opacity: 0.7 }}
            />
            <span
              className="h-1 rounded-full"
              style={{
                width: `${w * 3.5}px`,
                backgroundColor: tokens.boneMuted,
                opacity: 0.6,
              }}
            />
          </div>
        ))}
      </div>

      {/* Mini workspace */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mini top bar */}
        <div
          className="flex items-center justify-between px-2.5 py-1.5"
          style={{ borderBottom: `1px solid ${tokens.rule}` }}
        >
          <div className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: tokens.cobalt }}
            />
            <span
              className="h-1 w-12 rounded-full"
              style={{ backgroundColor: tokens.boneMuted, opacity: 0.75 }}
            />
          </div>
          <span
            className="px-1.5 py-0.5 text-[7px] font-medium leading-none"
            style={{
              backgroundColor: tokens.cobalt,
              color: tokens.onAccent,
              borderRadius: `${rSm}px`,
            }}
          >
            Co
          </span>
        </div>

        {/* Mini content: 3D brain pane + chrome cards */}
        <div className="grid min-h-0 flex-1 grid-cols-5 gap-2 p-2">
          {/* Mini 3D brain viewport */}
          <div
            className="relative col-span-3 overflow-hidden"
            style={{
              backgroundColor: manifest.palette.background,
              border: `1px solid ${tokens.rule}`,
              borderRadius: `${rCard}px`,
            }}
          >
            <svg viewBox="0 0 100 90" className="h-full w-full">
              {/* Subtle connecting edges */}
              <g stroke={manifest.palette.edge} strokeWidth="0.7" strokeOpacity="0.65">
                <line x1="24" y1="26" x2="52" y2="18" />
                <line x1="52" y1="18" x2="54" y2="44" />
                <line x1="54" y1="44" x2="76" y2="34" />
                <line x1="54" y1="44" x2="34" y2="58" />
                <line x1="54" y1="44" x2="64" y2="66" />
                <line x1="34" y1="58" x2="18" y2="74" />
              </g>
              {/* Expanding pulse ring around lit node */}
              <circle
                cx="54"
                cy="44"
                r="13"
                fill="none"
                stroke={manifest.palette.pulse_read}
                strokeWidth="0.9"
                strokeOpacity="0.55"
              />
              <circle
                cx="54"
                cy="44"
                r="7.5"
                fill={manifest.palette.pulse_read}
                fillOpacity="0.28"
              />
              {SAMPLE_NODES.map((n, i) => (
                <circle
                  key={i}
                  cx={n.x}
                  cy={n.y}
                  r={n.r}
                  fill={n.key === "pulse" ? "#ffffff" : nodeColor(n.key)}
                  opacity={n.key === "pulse" ? 1 : 0.88}
                />
              ))}
            </svg>
          </div>

          {/* Mini chrome cards */}
          <div className="col-span-2 flex flex-col gap-1.5">
            <div
              className="flex flex-1 flex-col justify-between p-1.5"
              style={{
                backgroundColor: tokens.surface,
                border: `1px solid ${tokens.rule}`,
                borderRadius: `${rCard}px`,
              }}
            >
              <div className="space-y-1">
                <div
                  className="h-1.5 w-10 rounded-full"
                  style={{ backgroundColor: tokens.bone, opacity: 0.85 }}
                />
                <div
                  className="h-1 w-14 rounded-full"
                  style={{ backgroundColor: tokens.boneMuted, opacity: 0.55 }}
                />
              </div>
              <div
                className="h-2.5 w-9"
                style={{
                  backgroundColor: tokens.cobalt,
                  borderRadius: `${rSm}px`,
                }}
              />
            </div>

            <div
              className="flex items-center gap-1 p-1.5"
              style={{
                backgroundColor: tokens.surface,
                border: `1px solid ${tokens.rule}`,
                borderRadius: `${rCard}px`,
              }}
            >
              {[0.25, 0.55, 0.85, 1].map((alpha, idx) => (
                <span
                  key={idx}
                  className="h-2.5 flex-1"
                  style={{
                    backgroundColor:
                      idx === 0
                        ? tokens.surface2
                        : `color-mix(in oklch, ${tokens.cobalt} ${Math.round(alpha * 100)}%, ${tokens.surface2})`,
                    borderRadius: `${Math.min(rSm, 3)}px`,
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
