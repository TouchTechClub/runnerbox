import { createRootRoute, Outlet } from "@tanstack/react-router";

import { TooltipProvider } from "@/components/ui/tooltip";

function RootLayout() {
  return (
    <TooltipProvider delayDuration={300}>
      <Outlet />
    </TooltipProvider>
  );
}

export const rootRoute = createRootRoute({ component: RootLayout });
