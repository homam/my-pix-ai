import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = {
  title: BRAND.metaTitle,
  description: BRAND.description,
  openGraph: {
    title: BRAND.name,
    description: BRAND.tagline,
    type: "website",
  },
};

// Re-point the --color-brand-* tokens (defined with mypix defaults in
// globals.css @theme) at this deployment's brand palette. Rendered in <body>,
// after the compiled stylesheet, so it wins the cascade; for mypix it's a
// no-op (identical values).
const t = BRAND.theme;
const brandThemeCss = `:root{--color-brand-200:${t.brand200};--color-brand-300:${t.brand300};--color-brand-400:${t.brand400};--color-brand-500:${t.brand500};--color-brand-600:${t.brand600};--color-brand-2-400:${t.brand2_400};--color-brand-2-500:${t.brand2_500};}`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <style id="brand-theme">{brandThemeCss}</style>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
