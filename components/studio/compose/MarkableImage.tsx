"use client";

import type { CorrectionMarks } from "@/lib/composite/types";

/**
 * The current version with the user's correction marks drawn over it. In a
 * marking mode a click places the RED circle ("what is wrong") or the GREEN
 * dot ("where it should be"); coordinates are fractions of the image, which is
 * what the correction route and the server-side transplant expect.
 */
export function MarkableImage({
  src,
  alt,
  marks,
  marking,
  onMark,
}: {
  src: string;
  alt: string;
  marks: CorrectionMarks;
  marking: "what" | "where" | null;
  onMark: (kind: "what" | "where", x: number, y: number) => void;
}) {
  function click(e: React.MouseEvent<HTMLDivElement>) {
    if (!marking) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    onMark(marking, x, y);
  }

  return (
    <div
      onClick={click}
      className={`relative select-none ${marking ? "cursor-crosshair" : ""}`}
      role={marking ? "button" : undefined}
      aria-label={marking ? `Click the image to mark ${marking === "what" ? "what is wrong" : "where it should go"}` : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="w-full rounded-xl border border-white/10" draggable={false} />
      {marks.what && (
        <span
          className="absolute rounded-full border-[3px] shadow-[0_0_0_1px_rgba(0,0,0,0.6)] pointer-events-none"
          style={{
            borderColor: "#ef4444",
            left: `${marks.what.x * 100}%`,
            top: `${marks.what.y * 100}%`,
            width: `${marks.what.r * 200}%`,
            aspectRatio: "1",
            transform: "translate(-50%, -50%)",
          }}
        />
      )}
      {marks.what && marks.where && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
          <line
            x1={marks.what.x * 100}
            y1={marks.what.y * 100}
            x2={marks.where.x * 100}
            y2={marks.where.y * 100}
            stroke="#facc15"
            strokeWidth="2"
            strokeDasharray="6 4"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {marks.where && (
        <span
          className="absolute rounded-full border-[3px] shadow-[0_0_0_1px_rgba(0,0,0,0.6)] pointer-events-none"
          style={{
            borderColor: "#34d399",
            left: `${marks.where.x * 100}%`,
            top: `${marks.where.y * 100}%`,
            width: `${(marks.what?.r ?? 0.03) * 200}%`,
            aspectRatio: "1",
            transform: "translate(-50%, -50%)",
          }}
        />
      )}
    </div>
  );
}
