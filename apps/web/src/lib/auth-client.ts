import { createAuthClient } from "better-auth/react";
import { deviceAuthorizationClient } from "better-auth/client/plugins";

import { API_URL } from "./api";

/**
 * better-auth client — handles GitHub social sign-in, session reads, and the
 * RFC 8628 device-flow endpoints used by the /device approval page.
 * Same-origin in dev (vite proxies /api/auth → wrangler dev).
 */
// better-auth requires an ABSOLUTE base URL (it validates with new URL() at
// init — a relative "/api/auth" throws and blanks the whole app). In dev
// API_URL is empty, so fall back to same-origin and let vite proxy /api/auth.
const authBase =
  API_URL || (typeof window !== "undefined" ? window.location.origin : "http://localhost:5173");

export const authClient = createAuthClient({
  baseURL: `${authBase}/api/auth`,
  plugins: [deviceAuthorizationClient()],
});
