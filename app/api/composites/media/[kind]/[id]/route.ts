import { NextRequest, NextResponse } from "next/server";
import { makeLogger } from "@/lib/log";
import { compositeCaller, failure, unauthorized } from "@/lib/composite/http";
import { downloadName, exportPlan } from "@/lib/composite/dimensions";
import { upscaleJpeg } from "@/lib/composite/imaging";
import {
  compositePath,
  downloadObject,
  extFor,
  isOwnCompositePath,
  signRead,
  uploadObject,
} from "@/lib/composite/storage";
import type { CompositeSource, CompositeVersion } from "@/lib/composite/types";

// GET /api/composites/media/version/[id]?variant=preview|native|upscaled[&download=1]
// GET /api/composites/media/source/[id]?variant=reference|original[&download=1]
//
// The only way composite pixels leave the private bucket for a browser: the row
// is read with the caller's RLS client (owner-only), its path is checked to sit
// in the caller's own tree, and the response is a redirect to a signed URL that
// expires in minutes. `generated_images.url` for composites points here, so All
// photos works without the media ever being public.
//
// variant=upscaled is the labelled 4K-dimension export. It is made on first
// request (Lanczos resampling, no detail added) only when the native render is
// smaller than 4K; a 4K-class render IS the export.

export const maxDuration = 60;

const URL_TTL_S = 900;

type Params = { params: Promise<{ kind: string; id: string }> };

function redirect(url: string) {
  return NextResponse.redirect(url, {
    status: 302,
    headers: { "cache-control": "private, max-age=300" },
  });
}

export async function GET(req: NextRequest, { params }: Params) {
  const log = makeLogger("api/composites/media");
  const { kind, id } = await params;
  const caller = await compositeCaller();
  if (!caller) return unauthorized(log);
  const variant = req.nextUrl.searchParams.get("variant") ?? "preview";
  const download = req.nextUrl.searchParams.get("download") === "1";
  const notFound = () => NextResponse.json({ error: "Not found", reqId: log.reqId }, { status: 404 });
  const { supabase, serviceClient, user } = caller;

  try {
    if (kind === "version") {
      const { data } = await supabase.from("composite_versions").select("*").eq("id", id).maybeSingle();
      const v = data as CompositeVersion | null;
      if (!v || !isOwnCompositePath(v.native_path, user.id, v.group_id)) return notFound();
      const { data: g } = await supabase.from("composite_groups").select("name").eq("id", v.group_id).maybeSingle();
      const name = (g as { name: string } | null)?.name ?? "composite";
      const native = { width: v.native_width, height: v.native_height };

      if (variant === "preview") return redirect(await signRead(serviceClient, v.preview_path, URL_TTL_S));
      if (variant === "native") {
        const file = download ? downloadName(name, v.version_number, "native", native, extFor(v.native_mime)) : undefined;
        return redirect(await signRead(serviceClient, v.native_path, URL_TTL_S, file));
      }
      if (variant === "upscaled") {
        const plan = exportPlan(native);
        if (!plan.upscaled) {
          return NextResponse.json(
            { error: "This render is already native 4K — download the native file", reqId: log.reqId },
            { status: 409 }
          );
        }
        let path = v.export_path;
        if (!path || !isOwnCompositePath(path, user.id, v.group_id)) {
          path = compositePath(user.id, v.group_id, "exports", `${v.id}-${plan.upscaled.width}x${plan.upscaled.height}.jpg`);
          const up = await upscaleJpeg(
            await downloadObject(serviceClient, v.native_path),
            plan.upscaled.width,
            plan.upscaled.height
          );
          await uploadObject(serviceClient, path, up, "image/jpeg");
          await serviceClient
            .from("composite_versions")
            .update({ export_path: path, export_width: plan.upscaled.width, export_height: plan.upscaled.height })
            .eq("id", v.id);
          log.info("composite_export_created", { userId: user.id, versionId: v.id, dims: `${plan.upscaled.width}x${plan.upscaled.height}` });
        }
        const file = download ? downloadName(name, v.version_number, "upscaled", plan.upscaled, "jpg") : undefined;
        return redirect(await signRead(serviceClient, path, URL_TTL_S, file));
      }
      return NextResponse.json({ error: "Unknown variant", reqId: log.reqId }, { status: 400 });
    }

    if (kind === "source") {
      const { data } = await supabase.from("composite_sources").select("*").eq("id", id).maybeSingle();
      const s = data as CompositeSource | null;
      if (!s) return notFound();
      const path = variant === "original" ? s.storage_path : s.reference_path;
      if (!isOwnCompositePath(path, user.id, s.group_id)) return notFound();
      return redirect(await signRead(serviceClient, path!, URL_TTL_S, download ? s.original_name : undefined));
    }
    return notFound();
  } catch (err) {
    return failure(log, err, "composite_media_failed", { userId: user.id, kind, id, variant });
  }
}
