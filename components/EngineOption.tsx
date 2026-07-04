import { CheckCircle } from "lucide-react";

// User-facing engine tiers. We deliberately do not surface the underlying
// vendor/model (Astria FLUX.1 "Standard" vs fal FLUX.2 "Ultra") — just a quality
// ladder. Shared by the new-model form and the retrain panel.
export type Engine = "astria" | "fal";

export function EngineOption({
  selected,
  disabled,
  onSelect,
  title,
  subtitle,
  badge,
}: {
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`text-left rounded-xl border p-4 transition-colors disabled:cursor-not-allowed ${
        selected
          ? "border-brand-500 bg-brand-500/10"
          : "border-white/10 hover:border-brand-500/40 hover:bg-white/3"
      } ${disabled && !selected ? "opacity-50" : ""}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-medium text-white">{title}</span>
        {badge && (
          <span className="text-[10px] uppercase tracking-wide bg-brand-500/20 text-brand-200 rounded px-1.5 py-0.5">
            {badge}
          </span>
        )}
        {selected && <CheckCircle className="w-4 h-4 text-brand-300 ml-auto" />}
      </div>
      <p className="text-xs text-gray-400 leading-snug">{subtitle}</p>
    </button>
  );
}
