import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

function makeCookieHandlers(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  return {
    getAll: () => cookieStore.getAll(),
    setAll: (
      cookiesToSet: { name: string; value: string; options?: CookieOptions }[]
    ) => {
      try {
        cookiesToSet.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, options)
        );
      } catch {}
    },
  };
}

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: makeCookieHandlers(cookieStore) }
  );
}

// IMPORTANT: do not use @supabase/ssr's createServerClient here. That helper
// reads the user's session cookies and attaches the user's JWT to every
// request, which overrides the service_role key — so requests run under the
// authenticated user role and are subject to RLS, defeating the whole point.
//
// Use the plain supabase-js client with no auth/session persistence so the
// service_role JWT is the only Authorization header sent.
export async function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "createServiceClient: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  return createSupabaseClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
