import { useMutation } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { authClient } from "../lib/auth-client";
import { Spinner } from "../components/ui";
import { rootRoute } from "./root";

type DeviceSearch = { user_code?: string };

type Phase = "claiming" | "confirm" | "done" | "denied" | "error";

function DevicePage() {
  const { user_code } = deviceRoute.useSearch();
  const [phase, setPhase] = useState<Phase>(user_code ? "claiming" : "error");
  const [error, setError] = useState<string | null>(null);
  const claimed = useRef(false);

  // Step 1: GET /device claims the pending code for this session — only this
  // session can then approve or deny it.
  const claim = useMutation({
    mutationFn: (code: string) => authClient.device({ query: { user_code: code } }),
    onSuccess: (res) => {
      if (res.error) {
        setError(res.error.error_description ?? res.error.error);
        setPhase("error");
      } else {
        setPhase("confirm");
      }
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : "Invalid or expired code");
      setPhase("error");
    },
  });

  const decide = useMutation({
    mutationFn: ({ code, approve }: { code: string; approve: boolean }) =>
      approve
        ? authClient.device.approve({ userCode: code })
        : authClient.device.deny({ userCode: code }),
    onSuccess: (res, v) => {
      if (res.error) {
        setError(res.error.error_description ?? res.error.error);
        setPhase("error");
      } else {
        setPhase(v.approve ? "done" : "denied");
      }
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : "Request failed");
      setPhase("error");
    },
  });

  // Auto-claim on mount when a code arrived via ?user_code= (StrictMode-safe).
  useEffect(() => {
    if (user_code && !claimed.current) {
      claimed.current = true;
      claim.mutate(user_code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user_code]);

  return (
    <div className="card">
      <h2>CLI authorization</h2>
      <div className="card-body">
        {!user_code ? (
          <div className="notice error">
            Missing device code. Run <code>runnerbox login</code> again and open the link it prints.
          </div>
        ) : phase === "claiming" ? (
          <Spinner label={`verifying code ${user_code}…`} />
        ) : phase === "confirm" ? (
          <>
            <p>A device is asking to sign in to your RunnerBox account.</p>
            <p className="mono big-code">{user_code}</p>
            <p className="muted small">
              Only approve if <strong>you</strong> just ran <code>runnerbox login</code> and this
              code matches your terminal. Never approve a code someone else gave you.
            </p>
            <div className="gap mt">
              <button
                type="button"
                className="btn primary"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ code: user_code, approve: true })}
              >
                Approve
              </button>
              <button
                type="button"
                className="btn"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ code: user_code, approve: false })}
              >
                Deny
              </button>
            </div>
          </>
        ) : phase === "done" ? (
          <div className="notice info">
            ✅ CLI authorized — return to your terminal. You can close this tab.
          </div>
        ) : phase === "denied" ? (
          <div className="notice info">Request denied. You can close this tab.</div>
        ) : (
          <div className="notice error">
            {error ?? "Something went wrong."} The code may have expired — run{" "}
            <code>runnerbox login</code> again.
          </div>
        )}
      </div>
    </div>
  );
}

export const deviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/device",
  validateSearch: (search: Record<string, unknown>): DeviceSearch => ({
    user_code:
      // better-auth's verification_uri_complete uses ?user_code=; accept ?code= too
      // for hand-typed links.
      typeof search.user_code === "string" && search.user_code
        ? search.user_code
        : typeof search.code === "string" && search.code
          ? search.code
          : undefined,
  }),
  component: DevicePage,
});
