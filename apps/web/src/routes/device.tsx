import { useMutation } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { api, ApiError } from "../lib/api";
import { Spinner } from "../components/ui";
import { rootRoute } from "./root";

type DeviceSearch = { code?: string };

function DevicePage() {
  const { code } = deviceRoute.useSearch();

  const approve = useMutation({
    mutationFn: (userCode: string) => api.approveCli(userCode),
  });
  // Guard against StrictMode double-invocation of the mount effect.
  const fired = useRef(false);

  useEffect(() => {
    if (code && !fired.current) {
      fired.current = true;
      approve.mutate(code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (!code) {
    return (
      <div className="card">
        <h2>CLI authorization</h2>
        <div className="card-body">
          <div className="notice error">
            Missing device code. Run <code>runnerbox login</code> again and open the link it
            prints.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>CLI authorization</h2>
      <div className="card-body">
        {approve.isPending ? (
          <Spinner label={`authorizing device code ${code}…`} />
        ) : null}

        {approve.isSuccess ? (
          <div className="notice info">
            ✅ CLI authorized — return to your terminal. You can close this tab.
          </div>
        ) : null}

        {approve.isError ? (
          <div className="notice error">
            Could not approve this code:{" "}
            {approve.error instanceof ApiError ? approve.error.message : "unknown error"}.
            The code may have expired — run <code>runnerbox login</code> again.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const deviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/device",
  validateSearch: (search: Record<string, unknown>): DeviceSearch => ({
    code: typeof search.code === "string" && search.code ? search.code : undefined,
  }),
  component: DevicePage,
});
