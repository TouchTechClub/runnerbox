import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/*
 * App-shell sidebar primitives (fixed 16rem icon+label rail).
 * Composition: <Sidebar><SidebarHeader/><SidebarContent><SidebarGroup>…
 * <SidebarMenu><SidebarMenuItem><SidebarMenuButton/></SidebarMenuItem>
 * </SidebarMenu></SidebarGroup></SidebarContent><SidebarFooter/></Sidebar>
 */

function Sidebar({ className, ...props }: ComponentProps<"aside">) {
  return (
    <aside
      data-slot="sidebar"
      className={cn(
        "flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn(
        "flex items-center gap-2 border-b border-sidebar-border px-4 py-3.5",
        className,
      )}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4", className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("mt-auto border-t border-sidebar-border p-3", className)}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="sidebar-group" className={cn("flex flex-col gap-1", className)} {...props} />
  );
}

function SidebarGroupLabel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        "px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("flex w-full flex-col gap-0.5", className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={cn("relative", className)} {...props} />;
}

const sidebarMenuButtonVariants = cva(
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground",
      },
      isActive: {
        true: "bg-sidebar-accent font-medium text-sidebar-foreground [&_svg]:text-sidebar-primary",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      isActive: false,
    },
  },
);

function SidebarMenuButton({
  className,
  isActive,
  variant,
  asChild = false,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof sidebarMenuButtonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="sidebar-menu-button"
      className={cn(sidebarMenuButtonVariants({ variant, isActive }), className)}
      {...props}
    />
  );
}

function SidebarMenuBadge({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="sidebar-menu-badge"
      className={cn(
        "ml-auto rounded border border-sidebar-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
};
