import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { Env } from "./env";

/**
 * better-auth instance factory. Workers get bindings per-request via `c.env`,
 * so the auth object can't be a module-level singleton — build one per request
 * (cheap: the adapter just wraps env.DB in a Kysely D1 dialect).
 *
 * Tables live in the same D1 database (see migrations/0002_better_auth.sql):
 *   user, session, account, verification, deviceCode
 */
export function createAuth(env: Env) {
  return betterAuth({
    database: {
      db: new Kysely({ dialect: new D1Dialect({ database: env.DB }) }),
      type: "sqlite",
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.API_URL,
    trustedOrigins: [env.APP_URL],
    telemetry: { enabled: false },
    advanced: {
      database: {
        // D1 rejects the PRAGMA introspection the kysely sqlite introspector
        // uses (SQLITE_AUTH), so the runtime schema check can't run — the
        // tables are owned by migrations/0002_better_auth.sql anyway.
        validateSchema: false,
      },
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        // Stash the GitHub login on user.login (additional field) — the
        // default `name` column gets GitHub's display name, not the handle.
        mapProfileToUser: (profile) => ({ login: profile.login }),
      },
    },
    user: {
      additionalFields: {
        login: { type: "string" },
      },
    },
    plugins: [
      deviceAuthorization({
        verificationUri: `${env.APP_URL}/device`,
        expiresIn: "10m",
        interval: "3s",
        validateClient: (id) => id === "runnerbox-cli",
      }),
      // Lets the CLI call /v1/* with `Authorization: Bearer <access_token>`
      // — the device/token endpoint issues a session token, and this hook
      // translates it into the session cookie for getSession.
      bearer(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
