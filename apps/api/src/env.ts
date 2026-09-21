/** Worker bindings + vars/secrets (see wrangler.toml / .dev.vars.example). */
export interface Env {
  DB: D1Database;
  KV: KVNamespace;

  GITHUB_APP_ID: string;
  /** PEM-encoded RSA private key for the GitHub App (secret). */
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  /** Web app origin — used for OAuth redirects and CLI device verify URLs. */
  APP_URL: string;
}
