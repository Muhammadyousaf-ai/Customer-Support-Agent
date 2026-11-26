"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/features/workspace/hooks/use-theme";

/** shadcn-style toaster: neutral surfaces from the design tokens, follows the app's light/dark theme. */
export function Toaster(props: ToasterProps) {
  const [, , dark] = useTheme();
  return (
    <Sonner
      theme={dark ? "dark" : "light"}
      position="bottom-right"
      closeButton
      style={{ "--normal-bg": "var(--popover)", "--normal-text": "var(--popover-foreground)", "--normal-border": "var(--border)" } as React.CSSProperties}
      {...props}
    />
  );
}

export { toast } from "sonner";
