"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Eraser, Paintbrush, RotateCcw } from "lucide-react";

interface Props {
  imageUrl: string;
  // Called with a black/white PNG blob of the mask (white = repaint area)
  // at the source image's natural resolution, or null when the mask is empty.
  onMaskChange: (mask: Blob | null) => void;
}

/**
 * Paint-over mask editor. The user brushes over the areas to replace;
 * we keep a full-resolution offscreen mask canvas (black background,
 * white strokes) in sync with the visible overlay.
 */
export function MaskCanvas({ imageUrl, onMaskChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const drawingRef = useRef(false);
  const hasStrokesRef = useRef(false);
  const [brushSize, setBrushSize] = useState(40);
  const [erasing, setErasing] = useState(false);
  const [ready, setReady] = useState(false);

  // Load the image and size both canvases.
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      const overlay = overlayRef.current;
      const container = containerRef.current;
      if (!overlay || !container) return;

      const maxW = container.clientWidth;
      const scale = Math.min(1, maxW / img.naturalWidth);
      overlay.width = Math.round(img.naturalWidth * scale);
      overlay.height = Math.round(img.naturalHeight * scale);

      const mask = document.createElement("canvas");
      mask.width = img.naturalWidth;
      mask.height = img.naturalHeight;
      const mctx = mask.getContext("2d")!;
      mctx.fillStyle = "black";
      mctx.fillRect(0, 0, mask.width, mask.height);
      maskRef.current = mask;
      hasStrokesRef.current = false;
      setReady(true);
      redrawAccurate();
    };
    img.src = imageUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  // Redraws the visible canvas: source image + purple tint wherever the
  // full-res mask is white. The mask canvas is the single source of truth;
  // the tint is re-derived from it by thresholding luminance per pixel.
  const redrawAccurate = useCallback(() => {
    const overlay = overlayRef.current;
    const img = imgRef.current;
    const mask = maskRef.current;
    if (!overlay || !img || !mask) return;
    const ctx = overlay.getContext("2d")!;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.drawImage(img, 0, 0, overlay.width, overlay.height);

    const scaled = document.createElement("canvas");
    scaled.width = overlay.width;
    scaled.height = overlay.height;
    const sctx = scaled.getContext("2d")!;
    sctx.drawImage(mask, 0, 0, scaled.width, scaled.height);
    const data = sctx.getImageData(0, 0, scaled.width, scaled.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const white = px[i] > 127;
      px[i] = 168; // purple-500
      px[i + 1] = 85;
      px[i + 2] = 247;
      px[i + 3] = white ? 140 : 0;
    }
    sctx.putImageData(data, 0, 0);
    ctx.drawImage(scaled, 0, 0);
  }, []);

  function pointerPos(e: React.PointerEvent<HTMLCanvasElement>) {
    const overlay = overlayRef.current!;
    const rect = overlay.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * overlay.width,
      y: ((e.clientY - rect.top) / rect.height) * overlay.height,
    };
  }

  function strokeTo(x: number, y: number) {
    const overlay = overlayRef.current;
    const mask = maskRef.current;
    if (!overlay || !mask) return;
    const scale = mask.width / overlay.width;
    const mctx = mask.getContext("2d")!;
    mctx.fillStyle = erasing ? "black" : "white";
    mctx.beginPath();
    mctx.arc(x * scale, y * scale, (brushSize / 2) * scale, 0, Math.PI * 2);
    mctx.fill();
    if (!erasing) hasStrokesRef.current = true;
  }

  async function emitMask() {
    const mask = maskRef.current;
    if (!mask) return;
    if (!hasStrokesRef.current) {
      onMaskChange(null);
      return;
    }
    mask.toBlob((blob) => onMaskChange(blob), "image/png");
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    drawingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = pointerPos(e);
    strokeTo(x, y);
    redrawAccurate();
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const { x, y } = pointerPos(e);
    strokeTo(x, y);
    redrawAccurate();
  }

  function onPointerUp() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    void emitMask();
  }

  function clearMask() {
    const mask = maskRef.current;
    if (!mask) return;
    const mctx = mask.getContext("2d")!;
    mctx.fillStyle = "black";
    mctx.fillRect(0, 0, mask.width, mask.height);
    hasStrokesRef.current = false;
    redrawAccurate();
    onMaskChange(null);
  }

  return (
    <div ref={containerRef} className="space-y-3">
      <canvas
        ref={overlayRef}
        className="rounded-xl border border-white/10 w-full touch-none cursor-crosshair"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      />
      {ready && (
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setErasing(false)}
              className={`p-2 rounded-lg border transition-colors ${
                !erasing
                  ? "bg-purple-500/20 border-purple-500/40 text-purple-300"
                  : "border-white/10 text-gray-400 hover:text-white"
              }`}
              title="Paint mask"
            >
              <Paintbrush className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setErasing(true)}
              className={`p-2 rounded-lg border transition-colors ${
                erasing
                  ? "bg-purple-500/20 border-purple-500/40 text-purple-300"
                  : "border-white/10 text-gray-400 hover:text-white"
              }`}
              title="Erase mask"
            >
              <Eraser className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={clearMask}
              className="p-2 rounded-lg border border-white/10 text-gray-400 hover:text-white transition-colors"
              title="Clear mask"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Brush
            <input
              type="range"
              min={10}
              max={120}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="accent-purple-500"
            />
          </label>
          <span className="text-xs text-gray-500">
            Paint over what you want replaced
          </span>
        </div>
      )}
    </div>
  );
}
