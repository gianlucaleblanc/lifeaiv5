import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Used only in API route handlers (not in client components)
export async function createSupabaseServerClient() {
  const cookieStore = await cookies(); // must be awaited in Next.js 16
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — safe to ignore in this context
          }
        },
      },
    }
  );
}
