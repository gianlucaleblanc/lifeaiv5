// ─────────────────────────────────────────────────────────────
// Google Calendar OAuth callback  (Phase 6a)
// Receives ?code=... from Google, stores tokens in cookies,
// then redirects back to /calendar with ?gcal=connected
//
// NOTE: Token exchange happens client-side via a tiny HTML page
// that reads the code_verifier from localStorage (PKCE requires
// the same client that generated the verifier to exchange it).
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
    return NextResponse.redirect(new URL("/calendar?gcal=denied", request.url));
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL("/calendar?gcal=error", request.url));
  }

  // Pass code + state to the client via URL params so the browser-side
  // JS can complete the PKCE exchange using the stored code_verifier.
  // We redirect to a client-side exchange page that handles the rest.
  const redirectUrl = new URL("/calendar", request.url);
  redirectUrl.searchParams.set("gcal_code", code);
  redirectUrl.searchParams.set("gcal_state", state);

  return NextResponse.redirect(redirectUrl);
}
