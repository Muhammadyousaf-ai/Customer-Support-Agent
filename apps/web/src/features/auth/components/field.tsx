"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Labelled input. Password fields get a show/hide toggle. */
export function Field({ label, id, type, ...props }: { label: string; id: string } & ComponentProps<typeof Input>) {
  const [visible, setVisible] = useState(false);
  const isPassword = type === "password";
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {isPassword ? (
        <div className="relative">
          <Input id={id} type={visible ? "text" : "password"} className="pr-10" {...props} />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground"
            aria-label={visible ? "Hide password" : "Show password"}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOff /> : <Eye />}
          </Button>
        </div>
      ) : (
        <Input id={id} type={type} {...props} />
      )}
    </div>
  );
}
