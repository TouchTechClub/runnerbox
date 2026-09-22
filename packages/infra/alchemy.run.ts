import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * RunnerBox infra — deploys the API worker, D1 (drizzle migrations), KV,
 * and the TanStack web SPA as Cloudflare resources.
 *
 * One-time setup:
 *   cd packages/infra && bunx alchemy profile edit   # CF credentials
 *   cp .env.example .env   # fill secrets
 *
 * Then:  bun run deploy    (in packages/infra, or `bun run deploy` at root)
 */
export const db = Cloudflare.D1.Database("runnerbox-db", {
  migrations: "../db/migrations",
});

export const kv = Cloudflare.KV.Namespace("runnerbox-kv");

export const api = Cloudflare.Worker("runnerbox-api", {
  main: "../../apps/api/src/index.ts",
  compatibility: {
    flags: ["nodejs_compat"],
  },
  env: {
    DB: db,
    KV: kv,

    // Public origins — web URL is known only after the site deploys, so these
    // are patched by the stack below via secrets/vars on first deploy.
    APP_URL: Config.String("APP_URL").pipe(Config.withDefault("http://localhost:5173")),
    API_URL: Cloudflare.Worker.URL,

    GITHUB_APP_ID: Config.String("GITHUB_APP_ID"),
    GITHUB_APP_PRIVATE_KEY: Config.Redacted("GITHUB_APP_PRIVATE_KEY"),
    GITHUB_WEBHOOK_SECRET: Config.Redacted("GITHUB_WEBHOOK_SECRET"),
    GITHUB_CLIENT_ID: Config.String("GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: Config.Redacted("GITHUB_CLIENT_SECRET"),
    BETTER_AUTH_SECRET: Config.Redacted("BETTER_AUTH_SECRET"),

    DEMO_MODE: Config.String("DEMO_MODE").pipe(Config.withDefault("false")),
  },
  dev: {
    port: 8787,
  },
});

export type ApiEnv = Cloudflare.InferEnv<typeof api>;

export default Alchemy.Stack(
  "runnerbox",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const apiWorker = yield* api;

    const web = yield* Cloudflare.Website.Vite("runnerbox-web", {
      rootDir: "../../apps/web",
      assets: {
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "single-page-application",
      },
      env: {
        VITE_API_URL: apiWorker.url.as<string>(),
      },
      dev: {
        port: 5173,
      },
    });

    return {
      api: apiWorker.url,
      web: web.url,
    };
  }),
);
