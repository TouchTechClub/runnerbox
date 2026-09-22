import { createAuthClient } from "better-auth/react";
import { deviceAuthorizationClient } from "better-auth/client/plugins";

import { API_URL } from "./api";

/**
 * better-auth client — handles GitHub social sign-in, session reads, and the
 * RFC 8628 device-flow endpoints used by the /device approval page.
 * Same-origin in dev (vite proxies /api/auth → wrangler dev).
 */
export const authClient = createAuthClient({
  baseURL: `${API_URL}/api/auth`,
  plugins: [deviceAuthorizationClient()],
});
