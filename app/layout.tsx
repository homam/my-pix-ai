import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "MyPix AI — AI-Powered Photo Studio",
  description:
    "Upload 10–20 photos of yourself and generate stunning photorealistic AI portraits in any setting, outfit, or style.",
  openGraph: {
    title: "MyPix AI",
    description: "Your AI photo studio. Train once, generate forever.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
