import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/brand";

// Brand favicon: gradient tile + sparkle mark, generated at build time from
// BRAND.theme (replaces the old static icon.svg whose gradient stops had to be
// kept in sync by hand). Same Lucide "sparkles" glyph as components/brand/Logo.tsx.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 7,
          background: `linear-gradient(135deg, ${BRAND.theme.brand500}, ${BRAND.theme.brand2_500})`,
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24">
          <path
            fill="#fff"
            d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
          />
          <path fill="#fff" d="M19 2.5a.5.5 0 0 1 1 0V4h1.5a.5.5 0 0 1 0 1H20v1.5a.5.5 0 0 1-1 0V5h-1.5a.5.5 0 0 1 0-1H19z" />
          <path fill="#fff" d="M3.5 16.5a.5.5 0 0 1 1 0V18H6a.5.5 0 0 1 0 1H4.5v1.5a.5.5 0 0 1-1 0V19H2a.5.5 0 0 1 0-1h1.5z" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
