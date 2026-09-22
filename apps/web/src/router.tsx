import { createRouter } from "@tanstack/react-router";

import { appRoute } from "./routes/app";
import { dashboardRoute } from "./routes/dashboard";
import { deviceRoute } from "./routes/device";
import { indexRoute } from "./routes/index";
import { onboardingRoute } from "./routes/onboarding";
import { rootRoute } from "./routes/root";

const routeTree = rootRoute.addChildren([
  indexRoute,
  deviceRoute,
  appRoute.addChildren([dashboardRoute, onboardingRoute]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
