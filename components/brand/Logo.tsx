// Swappable brand logo — the ONE place the mark + wordmark live (see
// CLAUDE.md "White-label / rebranding"). A rebrand swaps the mark or layout
// here once and every header/footer call site picks it up. The wordmark text
// always comes from BRAND — never hardcode a brand name here or at call sites.
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { BRAND } from "@/lib/brand";

const SIZES = {
  /** Footer row — inherits the surrounding text style. */
  sm: { mark: "w-4 h-4", text: "" },
  /** Compact headers (dashboard sidebar, share page). */
  md: { mark: "w-5 h-5", text: "font-semibold" },
  /** Top-level page headers. */
  lg: { mark: "w-6 h-6", text: "text-lg font-semibold" },
} as const;

/** The brand mark alone (no wordmark). */
export function LogoMark({ className = "w-6 h-6" }: { className?: string }) {
  return <Sparkles className={`${className} text-brand-400`} />;
}

/**
 * Mark + wordmark. With `href` it renders as a real link (new-tab friendly);
 * without, as a plain inline group (e.g. the landing header and footer).
 */
export function Logo({
  size = "lg",
  href,
  className,
}: {
  size?: keyof typeof SIZES;
  href?: string;
  className?: string;
}) {
  const s = SIZES[size];
  const cls = ["flex items-center gap-2", className].filter(Boolean).join(" ");
  const content = (
    <>
      <LogoMark className={s.mark} />
      <span className={s.text}>{BRAND.name}</span>
    </>
  );
  return href ? (
    <Link href={href} className={cls}>
      {content}
    </Link>
  ) : (
    <div className={cls}>{content}</div>
  );
}
