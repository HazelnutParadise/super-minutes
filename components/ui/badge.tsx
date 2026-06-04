import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-medium small-caps transition-colors",
  {
    variants: {
      variant: {
        default: "border-cream-100/20 bg-cream-100/[0.04] text-cream-200",
        vermillion: "border-vermillion/40 bg-vermillion/10 text-vermillion-400",
        jade: "border-jade/40 bg-jade/10 text-jade-400",
        outline: "border-cream-100/30 text-cream-200",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
