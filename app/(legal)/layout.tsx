import Link from "next/link";
import { Sparkles } from "lucide-react";
import { BRAND } from "@/lib/brand";

// Shared shell for /terms and /privacy. All brand-variable content (entity
// name, contact email) comes from lib/brand.ts so legal pages rebrand with
// the rest of the app.
export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <nav className="border-b border-white/5 backdrop-blur-sm sticky top-0 z-50 bg-black/50">
        <div className="max-w-3xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-purple-400" />
            <span className="text-lg font-semibold">{BRAND.name}</span>
          </Link>
          <Link
            href="/dashboard"
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            Dashboard
          </Link>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-16">{children}</main>

      <footer className="border-t border-white/5 py-10">
        <div className="max-w-3xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-500">
          <p>
            © {new Date().getFullYear()} {BRAND.legal.companyName}
          </p>
          <div className="flex gap-6">
            <Link href="/privacy" className="hover:text-gray-300 transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-gray-300 transition-colors">
              Terms
            </Link>
            <a
              href={`mailto:${BRAND.supportEmail}`}
              className="hover:text-gray-300 transition-colors"
            >
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
