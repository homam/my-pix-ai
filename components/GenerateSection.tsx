"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2, Download, Coins, RefreshCw, ChevronDown, Dice5, Info, X } from "lucide-react";
import { Model, GeneratedImage } from "@/types";

type RealismPreset = "polished" | "natural" | "documentary";
type AspectRatio = "1:1" | "4:5" | "2:3" | "3:2" | "9:16" | "16:9";

const REALISM_OPTIONS: {
  id: RealismPreset;
  label: string;
  blurb: string;
}[] = [
  {
    id: "polished",
    label: "Polished",
    blurb: "Smooth skin, professional-photoshoot look. Best for headshots and marketing.",
  },
  {
    id: "natural",
    label: "Natural",
    blurb: "Real skin texture and pores. Good default for portraits and social posts.",
  },
  {
    id: "documentary",
    label: "Documentary",
    blurb: "Most realistic — film grain and editorial style. Can look gritty.",
  },
];

const ASPECT_OPTIONS: { id: AspectRatio; label: string; hint: string }[] = [
  { id: "1:1", label: "1:1", hint: "Square — Instagram feed, profile" },
  { id: "4:5", label: "4:5", hint: "Portrait — Instagram feed-optimized" },
  { id: "2:3", label: "2:3", hint: "Vertical — print, photography" },
  { id: "3:2", label: "3:2", hint: "Horizontal — DSLR / classic photo" },
  { id: "9:16", label: "9:16", hint: "Tall — Stories, Reels, TikTok" },
  { id: "16:9", label: "16:9", hint: "Wide — desktop wallpaper, video" },
];

const SEED_MAX = 4_294_967_295; // 2^32 - 1
const randomSeed = () => Math.floor(Math.random() * SEED_MAX);

const PRESET_PROMPTS = [
  "Professional LinkedIn headshot, studio lighting, business attire",
  "Magazine cover editorial shoot, high fashion, dramatic lighting",
  "Casual portrait in a coffee shop, natural light, candid",
  "Corporate CEO portrait, modern office background",
  "Beach vacation, golden hour, relaxed and happy",
  "Fantasy warrior with armor in an epic landscape",
  "Astronaut in space with Earth in the background",
  "Renaissance oil painting style portrait",
  "Black and white artistic portrait, high contrast",
  "Street style fashion photography, urban background",
];

interface Props {
  model: Model;
  generatedImages: GeneratedImage[];
  creditBalance: number;
  creditCost: number;
}

export function GenerateSection({
  model,
  generatedImages: initialImages,
  creditBalance,
  creditCost,
}: Props) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [numImages, setNumImages] = useState(4);
  const [realism, setRealism] = useState<RealismPreset>("natural");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("1:1");
  const [filmGrain, setFilmGrain] = useState(true);
  const [faceCorrect, setFaceCorrect] = useState(false);
  const [superResolution, setSuperResolution] = useState(false);
  const [variety, setVariety] = useState(false);
  const [seed, setSeed] = useState<string>("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [images, setImages] = useState<GeneratedImage[]>(initialImages);
  const [detailImage, setDetailImage] = useState<GeneratedImage | null>(null);

  function applySettings(img: GeneratedImage) {
    setPrompt(img.prompt);
    const s = img.settings;
    if (s) {
      if (s.realism) setRealism(s.realism);
      if (s.aspectRatio) setAspectRatio(s.aspectRatio);
      if (typeof s.filmGrain === "boolean") setFilmGrain(s.filmGrain);
      if (typeof s.faceCorrect === "boolean") setFaceCorrect(s.faceCorrect);
      if (typeof s.superResolution === "boolean") setSuperResolution(s.superResolution);
      if (typeof s.variety === "boolean") setVariety(s.variety);
      if (typeof s.seed === "number") setSeed(String(s.seed));
      else setSeed("");
    }
    setDetailImage(null);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState(creditBalance);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  async function handleSync() {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch(`/api/models/${model.id}/sync`, { method: "POST" });
      if (!res.ok) {
        const { error } = await res.json();
        throw new Error(error ?? "Sync failed");
      }
      const { imported, scanned, failed } = await res.json();
      setSyncMessage(
        imported > 0
          ? `Imported ${imported} image${imported === 1 ? "" : "s"} from ${scanned} prompt${scanned === 1 ? "" : "s"}.${failed ? ` (${failed} failed)` : ""}`
          : `Already up to date. Scanned ${scanned} prompt${scanned === 1 ? "" : "s"}.`
      );
      router.refresh();
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;

    setGenerating(true);
    setError(null);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: model.id,
          prompt: prompt.trim(),
          numImages,
          realism,
          aspectRatio,
          filmGrain,
          faceCorrect,
          superResolution,
          variety,
          seed: seed.trim() === "" ? null : Number(seed),
        }),
      });

      if (!res.ok) {
        const { error } = await res.json();
        throw new Error(error ?? "Generation failed");
      }

      const { images: newImages } = await res.json();
      setImages((prev) => [...newImages, ...prev]);
      setBalance((b) => b - numImages * creditCost);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Generate form */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-6">
        <h2 className="font-semibold mb-4">Generate photos</h2>

        <form onSubmit={handleGenerate} className="space-y-4">
          {/* Prompt */}
          <div>
            <label className="block text-sm font-medium mb-2">
              Describe the photo you want
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Professional headshot in a modern office, business casual attire, warm lighting"
              rows={3}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-colors resize-none"
            />
          </div>

          {/* Preset prompts */}
          <div>
            <p className="text-xs text-gray-500 mb-2">Quick presets:</p>
            <div className="flex flex-wrap gap-2">
              {PRESET_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPrompt(p)}
                  className="text-xs bg-white/5 hover:bg-white/10 border border-white/10 rounded-full px-3 py-1.5 text-gray-400 hover:text-white transition-colors"
                >
                  {p.split(",")[0]}
                </button>
              ))}
            </div>
          </div>

          {/* Aspect ratio */}
          <div>
            <label className="block text-sm font-medium mb-2">Aspect ratio</label>
            <div className="flex flex-wrap gap-2">
              {ASPECT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setAspectRatio(opt.id)}
                  title={opt.hint}
                  className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                    aspectRatio === opt.id
                      ? "bg-purple-600 border-purple-600 text-white"
                      : "bg-white/5 border-white/10 text-gray-400 hover:text-white hover:bg-white/10"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {ASPECT_OPTIONS.find((o) => o.id === aspectRatio)?.hint}
            </p>
          </div>

          {/* Realism preset */}
          <div>
            <label className="block text-sm font-medium mb-2">Realism</label>
            <div className="inline-flex rounded-xl bg-white/5 border border-white/10 p-1">
              {REALISM_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setRealism(opt.id)}
                  className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${
                    realism === opt.id
                      ? "bg-purple-600 text-white"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {REALISM_OPTIONS.find((o) => o.id === realism)?.blurb}
            </p>
          </div>

          {/* Film grain — primary lever for fighting plastic skin, kept outside Advanced */}
          <div>
            <label className="flex items-start gap-3 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={filmGrain}
                onChange={(e) => setFilmGrain(e.target.checked)}
                className="mt-1 accent-purple-500"
              />
              <div>
                <div className="font-medium">Film grain</div>
                <p className="text-xs text-gray-500">
                  Adds visible film noise. Helps fight the plastic-AI look. Turn off
                  if photos feel too noisy or low-resolution.
                </p>
              </div>
            </label>
          </div>

          {/* Advanced */}
          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${
                  advancedOpen ? "rotate-180" : ""
                }`}
              />
              Advanced
            </button>
            {advancedOpen && (
              <div className="mt-3 space-y-3 pl-1">
                <label className="flex items-start gap-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={faceCorrect}
                    onChange={(e) => setFaceCorrect(e.target.checked)}
                    className="mt-1 accent-purple-500"
                  />
                  <div>
                    <div className="font-medium">Polish face</div>
                    <p className="text-xs text-gray-500">
                      Runs a face-restoration pass that smooths skin and sharpens
                      features. Good for headshots — but it&apos;s the main reason AI
                      photos look plastic. Off by default.
                    </p>
                  </div>
                </label>
                <label className="flex items-start gap-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={superResolution}
                    onChange={(e) => setSuperResolution(e.target.checked)}
                    className="mt-1 accent-purple-500"
                  />
                  <div>
                    <div className="font-medium">Upscale 4×</div>
                    <p className="text-xs text-gray-500">
                      Renders at higher resolution. Adds detail to clothing and
                      backgrounds, but can re-smooth skin texture. Slower.
                    </p>
                  </div>
                </label>

                <label className="flex items-start gap-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={variety}
                    onChange={(e) => setVariety(e.target.checked)}
                    disabled={numImages < 2}
                    className="mt-1 accent-purple-500 disabled:opacity-50"
                  />
                  <div className={numImages < 2 ? "opacity-60" : ""}>
                    <div className="font-medium">More variety</div>
                    <p className="text-xs text-gray-500">
                      Submits each photo as its own request with a different random
                      seed — much more variation in pose, expression, and composition.
                      Same credit cost, slightly slower. Needs 2+ photos to do anything.
                    </p>
                  </div>
                </label>

                <div>
                  <div className="font-medium text-sm">Seed</div>
                  <p className="text-xs text-gray-500 mb-2">
                    Same seed + same prompt + same settings = same image. Leave empty
                    for a fresh random photo each time. Hit the dice to lock a new
                    random seed and remix it. Ignored when &ldquo;More variety&rdquo; is on.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={SEED_MAX}
                      value={seed}
                      onChange={(e) => setSeed(e.target.value)}
                      placeholder="random"
                      disabled={variety && numImages > 1}
                      className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm font-mono text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() => setSeed(String(randomSeed()))}
                      disabled={variety && numImages > 1}
                      title="Generate a random seed"
                      className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 hover:text-white transition-colors disabled:opacity-50"
                    >
                      <Dice5 className="w-4 h-4" />
                    </button>
                    {seed && (
                      <button
                        type="button"
                        onClick={() => setSeed("")}
                        className="shrink-0 text-xs text-gray-500 hover:text-gray-300 transition-colors px-2"
                      >
                        clear
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Num images */}
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium shrink-0">
              Number of photos:
            </label>
            {[1, 2, 4, 8].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setNumImages(n)}
                className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors ${
                  numImages === n
                    ? "bg-purple-600 text-white"
                    : "bg-white/5 text-gray-400 hover:bg-white/10"
                }`}
              >
                {n}
              </button>
            ))}
          </div>

          {error && (
            <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-sm text-gray-500">
              <Coins className="w-4 h-4" />
              <span>
                {numImages * creditCost} credit{numImages > 1 ? "s" : ""} ·{" "}
                {balance} remaining
              </span>
            </div>
            <button
              type="submit"
              disabled={generating || !prompt.trim() || balance < numImages}
              className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-xl text-sm font-medium transition-colors"
            >
              {generating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Generate
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Sync row */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-500">
          {syncMessage ?? "Import past Astria generations into your library."}
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="inline-flex items-center gap-2 text-xs text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 disabled:opacity-50 transition-colors"
        >
          {syncing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          {syncing ? "Syncing…" : "Sync from Astria"}
        </button>
      </div>

      {/* Generated images grid */}
      {images.length > 0 && (
        <div>
          <h2 className="font-semibold mb-4">
            Generated photos ({images.length})
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {images.map((img) => (
              <GeneratedImageCard
                key={img.id}
                image={img}
                onShowDetails={() => setDetailImage(img)}
              />
            ))}
          </div>
        </div>
      )}

      {images.length === 0 && !generating && !syncing && (
        <div className="text-center py-12 text-gray-600 text-sm">
          Your generated photos will appear here. Click <strong>Sync from Astria</strong> above if you&apos;ve generated anything previously.
        </div>
      )}

      {/* Generating placeholders */}
      {generating && (
        <div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: numImages }).map((_, i) => (
              <div
                key={i}
                className="aspect-square rounded-xl bg-white/5 border border-white/8 animate-pulse"
              />
            ))}
          </div>
        </div>
      )}

      {detailImage && (
        <ImageDetailModal
          image={detailImage}
          onClose={() => setDetailImage(null)}
          onRemix={() => applySettings(detailImage)}
        />
      )}
    </div>
  );
}

function GeneratedImageCard({
  image,
  onShowDetails,
}: {
  image: GeneratedImage;
  onShowDetails: () => void;
}) {
  return (
    <div className="group relative aspect-square rounded-xl overflow-hidden bg-gray-900">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.url}
        alt={image.prompt}
        className="w-full h-full object-cover"
      />
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-end p-3 opacity-0 group-hover:opacity-100">
        <div className="flex items-center justify-between w-full gap-2">
          <p className="text-xs text-white truncate flex-1">{image.prompt}</p>
          <button
            type="button"
            onClick={onShowDetails}
            title="View prompt and settings"
            className="shrink-0 w-8 h-8 bg-white/20 hover:bg-white/30 backdrop-blur-sm rounded-lg flex items-center justify-center transition-colors"
          >
            <Info className="w-4 h-4 text-white" />
          </button>
          <a
            href={image.url}
            download
            target="_blank"
            rel="noreferrer"
            title="Download"
            className="shrink-0 w-8 h-8 bg-white/20 hover:bg-white/30 backdrop-blur-sm rounded-lg flex items-center justify-center transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <Download className="w-4 h-4 text-white" />
          </a>
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm py-1.5 border-b border-white/5 last:border-b-0">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-200 font-mono text-xs text-right">{value}</span>
    </div>
  );
}

function ImageDetailModal({
  image,
  onClose,
  onRemix,
}: {
  image: GeneratedImage;
  onClose: () => void;
  onRemix: () => void;
}) {
  const s = image.settings;
  const created = new Date(image.created_at).toLocaleString();
  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-neutral-900 border border-white/10 rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col md:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="md:w-1/2 bg-black flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.url}
            alt={image.prompt}
            className="max-h-[50vh] md:max-h-[90vh] w-auto object-contain"
          />
        </div>
        <div className="md:w-1/2 flex flex-col">
          <div className="flex items-start justify-between p-4 border-b border-white/10">
            <div>
              <h3 className="font-semibold">Generation details</h3>
              <p className="text-xs text-gray-500 mt-0.5">{created}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="overflow-y-auto p-4 space-y-4 flex-1">
            <div>
              <div className="text-xs text-gray-500 mb-1">Your prompt</div>
              <div className="text-sm bg-white/5 rounded-lg p-3 whitespace-pre-wrap">
                {image.prompt}
              </div>
            </div>
            {s?.fullPrompt && s.fullPrompt !== image.prompt && (
              <div>
                <div className="text-xs text-gray-500 mb-1">
                  Sent to Astria (with trigger + realism suffix)
                </div>
                <div className="text-xs bg-white/5 rounded-lg p-3 whitespace-pre-wrap font-mono text-gray-300">
                  {s.fullPrompt}
                </div>
              </div>
            )}
            <div>
              <div className="text-xs text-gray-500 mb-2">Settings</div>
              {s ? (
                <div className="bg-white/5 rounded-lg px-3">
                  <SettingRow label="Realism" value={s.realism ?? "—"} />
                  <SettingRow label="Aspect ratio" value={s.aspectRatio ?? "—"} />
                  <SettingRow
                    label="Film grain"
                    value={s.filmGrain ? "on" : "off"}
                  />
                  <SettingRow
                    label="Polish face"
                    value={s.faceCorrect ? "on" : "off"}
                  />
                  <SettingRow
                    label="Upscale 4×"
                    value={s.superResolution ? "on" : "off"}
                  />
                  <SettingRow
                    label="More variety"
                    value={s.variety ? "on" : "off"}
                  />
                  <SettingRow
                    label="cfg_scale"
                    value={s.cfgScale != null ? String(s.cfgScale) : "—"}
                  />
                  <SettingRow
                    label="Seed"
                    value={s.seed != null ? String(s.seed) : "random"}
                  />
                </div>
              ) : (
                <p className="text-xs text-gray-600 italic">
                  Settings weren&apos;t recorded for this image — generated before
                  the per-image settings column was added.
                </p>
              )}
            </div>
          </div>
          <div className="border-t border-white/10 p-4 flex items-center gap-2">
            <button
              type="button"
              onClick={onRemix}
              className="flex-1 inline-flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              Remix with these settings
            </button>
            <a
              href={image.url}
              download
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
              title="Download"
            >
              <Download className="w-4 h-4" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
