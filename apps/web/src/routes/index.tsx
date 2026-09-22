import { createRoute, redirect } from "@tanstack/react-router";
import { api } from "../lib/api";
import { rootRoute } from "./root";

function Landing() {
  return (
    <div className="hero">
      <div className="kicker">$ runnerbox sim</div>
      <h1>Free iOS &amp; Android simulators on your own GitHub Actions minutes</h1>
      <p className="lede">
        A macOS runner in your repo boots simulators and emulators, tunnels them to your
        machine, and tears itself down when you&apos;re done. Public repos cost you nothing.
      </p>
      <button
        type="button"
        className="btn primary lg"
        onClick={() => {
          void api
            .signInGithub()
            .then((url) => {
              window.location.href = url;
            });
        }}
      >
        Sign in with GitHub
      </button>
      <p className="hint">
        Uses the RunnerBox GitHub App — works with any repo you install it on.
      </p>
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async () => {
    // Already authed? Skip the landing — resume a pending flow (e.g. CLI
    // device approval) if there is one, else go to the dashboard.
    try {
      await api.me();
    } catch {
      return;
    }
    let back: string | null = null;
    try {
      back = sessionStorage.getItem("rb_return_to");
      sessionStorage.removeItem("rb_return_to");
    } catch {
      /* ignore */
    }
    if (back && back !== "/") throw redirect({ href: back });
    throw redirect({ to: "/dashboard" });
  },
  component: Landing,
});
