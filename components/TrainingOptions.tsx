"use client";

import { useState } from "react";
import { CheckCircle, Sliders, Sparkles } from "lucide-react";
import {
  TRAINING_PRESETS,
  resolveSteps,
  STEPS_MIN,
  STEPS_MAX,
  type TrainingQuality,
} from "@/lib/trainingPresets";
import type { Engine } from "@/components/EngineOption";

/**
 * Training-quality control shared by NewModelForm and RetrainPanel. Everyday
 * users pick a preset card; power users open "Advanced" for a raw step slider.
 *
 * State is lifted to the parent (it owns the request body): `quality` is the
 * selected preset and `customSteps` is the Advanced override (null = follow the
 * preset). The parent sends `quality` always, and `steps` only when customSteps
 * is non-null.
 */
export function TrainingOptions({
  engine,
  quality,
  onQualityChange,
  customSteps,
  onCustomStepsChange,
  disabled,
}: {
  engine: Engine;
  quality: TrainingQuality;
  onQualityChange: (q: TrainingQuality) => void;
  customSteps: number | null;
  onCustomStepsChange: (steps: number | null) => void;
  disabled: boolean;
}) {
  const [showAdvanced, setShowAdvanced] = useState(customSteps != null);

  // Steps the selected preset resolves to on this engine (null = engine auto).
  const presetSteps = resolveSteps(quality, engine);
  // The slider always needs a concrete number; when the preset is "auto" (null,
  // Standard/Balanced) start it at a representative midpoint.
  const sliderValue = customSteps ?? presetSteps ?? 1000;
  const usingCustom = customSteps != null;

  return (
    <div>
      <label className="block text-sm font-medium mb-1">Training quality</label>
      <p className="text-xs text-gray-500 mb-3">
        How hard we train on your photos. Higher means a stronger likeness but
        longer training.
      </p>

      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {TRAINING_PRESETS.map((p) => {
          const selected = !usingCustom && quality === p.id;
          return (
            <button
              key={p.id}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => {
                onCustomStepsChange(null); // leave Advanced/custom, follow preset
                onQualityChange(p.id);
              }}
              className={`relative text-left rounded-xl border p-3 transition-colors disabled:cursor-not-allowed ${
                selected
                  ? "border-brand-500 bg-brand-500/10"
                  : "border-white/10 hover:border-brand-500/40 hover:bg-white/3"
              } ${disabled && !selected ? "opacity-50" : ""}`}
            >
              <span className="flex items-center gap-1.5 mb-1">
                <span className="text-sm font-medium text-white">{p.label}</span>
                {selected && (
                  <CheckCircle className="w-3.5 h-3.5 text-brand-300 ml-auto shrink-0" />
                )}
              </span>
              <span className="block text-[11px] text-gray-400 leading-snug">
                {p.blurb}
              </span>
              {p.recommended && (
                <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-brand-300">
                  <Sparkles className="w-2.5 h-2.5" /> Recommended
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Advanced disclosure */}
      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="mt-3 inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
        aria-expanded={showAdvanced}
      >
        <Sliders className="w-3.5 h-3.5" />
        Advanced
        {usingCustom && (
          <span className="text-brand-300">· custom {customSteps} steps</span>
        )}
      </button>

      {showAdvanced && (
        <div className="mt-2 rounded-xl border border-white/10 bg-white/3 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-300">Training steps</span>
            <span className="text-xs tabular-nums text-brand-200">
              {usingCustom
                ? `${customSteps} (custom)`
                : presetSteps == null
                  ? "Auto"
                  : `${presetSteps} (${quality})`}
            </span>
          </div>

          <input
            type="range"
            min={STEPS_MIN}
            max={STEPS_MAX}
            step={100}
            value={sliderValue}
            disabled={disabled}
            onChange={(e) => onCustomStepsChange(Number(e.target.value))}
            className="w-full accent-brand-500 disabled:opacity-50"
            aria-label="Training steps"
          />
          <div className="flex items-center justify-between text-[11px] text-gray-500">
            <span>Faster · {STEPS_MIN}</span>
            <span>Stronger · {STEPS_MAX}</span>
          </div>

          <div className="flex items-start justify-between gap-3">
            <p className="text-[11px] text-gray-500 leading-snug">
              {engine === "fal"
                ? "More steps sharpen your likeness on the Ultra engine, but training takes longer."
                : "The Standard engine auto-tunes steps for you — only override this if you know what you want."}
            </p>
            {usingCustom && (
              <button
                type="button"
                onClick={() => onCustomStepsChange(null)}
                className="shrink-0 text-[11px] text-brand-300 hover:text-brand-200"
              >
                Reset to preset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
