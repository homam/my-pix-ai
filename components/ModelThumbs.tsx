import { Images } from "lucide-react";

export function ModelThumbs({
  urls,
  limit = 5,
  size = "md",
}: {
  urls: string[];
  limit?: number;
  size?: "sm" | "md";
}) {
  if (urls.length === 0) {
    return (
      <div className="aspect-video bg-white/5 rounded-xl flex items-center justify-center">
        <Images className="w-8 h-8 text-gray-600" />
      </div>
    );
  }

  const shown = urls.slice(0, limit);
  const remainder = urls.length - shown.length;
  const cellClass = size === "sm" ? "aspect-square" : "aspect-square";

  return (
    <div className="grid grid-cols-5 gap-1">
      {shown.map((url, i) => (
        <div
          key={i}
          className={`${cellClass} rounded-md overflow-hidden bg-gray-900 relative`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
          {i === shown.length - 1 && remainder > 0 && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-xs font-medium text-white">
              +{remainder}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
