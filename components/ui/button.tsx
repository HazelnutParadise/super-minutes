import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Cream-on-ink default — the editorial standard.
        default:
          "bg-cream-100 text-ink-900 shadow-sm hover:bg-cream-50 active:translate-y-px",
        // Vermillion — the one accent. Used for the single hero CTA.
        vermillion:
          "bg-vermillion text-cream-100 shadow-[0_4px_14px_-4px_rgba(212,63,63,0.6)] hover:bg-vermillion-600 active:translate-y-px",
        // Ghost — text only, hairline border on hover.
        ghost:
          "text-cream-100 hover:bg-cream-100/[0.06] hover:text-cream-50",
        // Outline — hairline rule, for secondary actions.
        outline:
          "border border-cream-100/30 bg-transparent text-cream-100 hover:border-cream-100/60 hover:bg-cream-100/[0.04]",
        // Destructive — used sparingly.
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        link: "text-cream-100 underline-offset-4 hover:underline decoration-vermillion",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-sm px-3 text-xs",
        lg: "h-11 rounded-sm px-6 text-base",
        xl: "h-12 rounded-sm px-8 text-base small-caps",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
