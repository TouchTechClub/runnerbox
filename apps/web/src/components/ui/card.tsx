import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-card text-card-foreground", className)}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 p-4 sm:p-5", className)} {...props} />;
}

function CardTitle({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("text-sm font-medium leading-none", className)} {...props} />;
}

function CardDescription({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-4 pt-0 sm:p-5 sm:pt-0", className)} {...props} />;
}

function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center p-4 pt-0 sm:p-5 sm:pt-0", className)} {...props} />;
}

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
