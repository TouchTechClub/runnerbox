import { Hono } from "hono";
import type { AppContext } from "./middleware";
import { authRoutes } from "./routes/auth";
import { repoRoutes } from "./routes/repo";
import { runRoutes } from "./routes/runs";
import { webhookRoutes } from "./routes/webhooks";

const app = new Hono<AppContext>();

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/", authRoutes);
app.route("/", repoRoutes);
app.route("/", runRoutes);
app.route("/", webhookRoutes);

app.notFound((c) => c.json({ error: "not_found", message: "Unknown route." }, 404));
app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json({ error: "internal", message: "Internal error." }, 500);
});

export default app;
