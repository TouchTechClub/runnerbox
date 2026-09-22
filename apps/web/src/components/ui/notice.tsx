import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const noticeVariants = cva(
  "flex gap-2.5 rounded-md border px-3.5 py-2.5 text-sm [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-border bg-muted/40 text-foreground",
        info: "border-primary/40 bg-primary/10 text-foreground",
        warning: "border-warning/40 bg-warning/10 text-foreground",
        destructive: "border-destructive/40 bg-destructive/10 text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Notice({
  className,
  variant,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof noticeVariants>) {
  return <div role="status" className={cn(noticeVariants({ variant }), className)} {...props} />;
}

export { Notice, noticeVariants };
