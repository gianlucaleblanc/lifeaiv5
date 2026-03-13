// ─────────────────────────────────────────────────────────────
// Outlook OAuth callback  (Phase 6f)
// Receives ?code=... from Microsoft, redirects back to /calendar
// with ?outlook_code=CODE&outlook_state=STATE so the browser-side
// JS can complete the PKCE exchange using the stored code_verifier.
// ─────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  // If the user denied access
  if (error) {
    return NextResponse.redirect(new URL("/calendar?outlook=denied", request.url));
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL("/calendar?outlook=error", request.url));
  }

  // Pass code + state to the client via URL params so the browser-side
  // JS can complete the PKCE exchange using the stored code_verifier.
  const redirectUrl = new URL("/calendar", request.url);
  redirectUrl.searchParams.set("outlook_code", code);
  redirectUrl.searchParams.set("outlook_state", state);

  return NextResponse.redirect(redirectUrl);
}
