import { createBrowserClient } from "@supabase/ssr";

// `db.schema: "mypix"` means every existing `.from("models")`, `.from("generated_images")`,
// etc. call in this app now targets `mypix.*` in the shared aionized platform project — no
// call site changes needed. Cross-product `core.*` RPCs (via @aionized/platform-client)
// explicitly call `.schema("core")`, which overrides this default per-request.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: "mypix" } }
  );
}
