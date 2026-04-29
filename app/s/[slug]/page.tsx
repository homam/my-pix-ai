import { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Sparkles } from "lucide-react";
import { createServiceClient } from "@/lib/supabase/server";

// ISR: first hit renders + caches, subsequent within 60s are served from
// cache, after 60s a background revalidate refreshes. Keeps OG scrapers and
// viral shares off the DB.
export const revalidate = 60;

type Share = {
  slug: string;
  prompt: string;
  image_ids: string[];
  view_count: number;
  created_at: string;
};

type ShareImage = {
  id: string;
  url: string;
  prompt: string;
};

async function loadShare(
  slug: string
): Promise<{ share: Share; images: ShareImage[] } | null> {
  // Service client so we can dereference image rows past their RLS policy
  // (generated_images are owner-only). The shares row itself is the access
  // grant: if you have the slug, you can see the images it points at.
  const svc = await createServiceClient();
  const { data: share } = await svc
    .from("shares")
    .select("slug, prompt, image_ids, view_count, created_at")
    .eq("slug", slug)
    .single();
  if (!share) return null;

  const { data: images } = await svc
    .from("generated_images")
    .select("id, url, prompt")
    .in("id", share.image_ids as string[]);
  if (!images || images.length === 0) return null;

  // Preserve the order from share.image_ids.
  const byId = new Map(images.map((i) => [i.id as string, i as ShareImage]));
  const ordered = (share.image_ids as string[])
    .map((id) => byId.get(id))
    .filter((i): i is ShareImage => Boolean(i));

  return { share: share as Share, images: ordered };
}

const APP_URL = (
  process.env.NEXT_PUBLIC_APP_URL ?? "https://my-pix.ai"
).replace(/\/$/, "");

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const data = await loadShare(slug);
  if (!data) return { title: "Share not found" };

  const { share, images } = data;
  const promptShort =
    share.prompt.length > 90 ? share.prompt.slice(0, 87).trimEnd() + "…" : share.prompt;
  const title = `AI photo: ${promptShort}`;
  const description = `${share.prompt}\n\nMade with MyPix AI — train a model on your own photos and generate any scenario.`;
  const url = `${APP_URL}/s/${slug}`;
  const imageUrl = images[0].url;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url,
      siteName: "MyPix AI",
      type: "article",
      images: [
        {
          url: imageUrl,
          width: 1024,
          height: 1024,
          alt: share.prompt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
    alternates: { canonical: url },
    robots: { index: true, follow: true },
  };
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await loadShare(slug);
  if (!data) notFound();

  // Fire-and-forget view increment. Don't await — render shouldn't wait on it.
  const svc = await createServiceClient();
  void svc.rpc("increment_share_view", { p_slug: slug });

  const { share, images } = data;
  const isMulti = images.length > 1;

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Sparkles className="w-5 h-5 text-purple-400" />
          MyPix AI
        </Link>
        <Link
          href="/login"
          className="text-sm bg-purple-600 hover:bg-purple-500 transition-colors text-white px-4 py-1.5 rounded-lg"
        >
          Make your own
        </Link>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">
        <section>
          <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">
            Prompt
          </p>
          <p className="text-lg text-gray-200 whitespace-pre-wrap">
            {share.prompt}
          </p>
        </section>

        <section>
          <div
            className={
              isMulti
                ? "grid grid-cols-1 sm:grid-cols-2 gap-4"
                : "flex justify-center"
            }
          >
            {images.map((img) => (
              <a
                key={img.id}
                href={img.url}
                target="_blank"
                rel="noreferrer"
                className="block rounded-2xl overflow-hidden bg-black border border-white/10 hover:border-white/30 transition-colors"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={share.prompt}
                  className="w-full h-auto object-contain"
                />
              </a>
            ))}
          </div>
        </section>

        <section className="border-t border-white/10 pt-8 text-center">
          <h2 className="text-2xl font-semibold mb-3">
            Want photos of yourself like this?
          </h2>
          <p className="text-gray-400 mb-6 max-w-xl mx-auto">
            Upload 15 selfies, MyPix AI trains a model on your face in ~10
            minutes, then generate yourself in any scene, outfit, or style.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 transition-colors text-white px-6 py-3 rounded-xl font-medium"
          >
            <Sparkles className="w-4 h-4" />
            Try MyPix AI
          </Link>
        </section>
      </main>

      <footer className="border-t border-white/10 px-6 py-6 text-center text-xs text-gray-600">
        Made with MyPix AI · {share.view_count.toLocaleString()} views
      </footer>
    </div>
  );
}
