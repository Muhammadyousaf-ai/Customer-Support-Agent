"use client";

import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** Spins for a moment after a click so a retry that resolves instantly still visibly "did something". */
export function RetryButton({ onRetry, disabled, label = "Retry" }: { onRetry: () => void; disabled?: boolean; label?: string }) {
  const [spinning, setSpinning] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const click = () => {
    setSpinning(true);
    timer.current = setTimeout(() => setSpinning(false), 700);
    onRetry();
  };
  return (
    <Button variant="outline" size="sm" onClick={click} disabled={disabled || spinning}>
      <RotateCw className={spinning ? "animate-spin" : undefined} /> {label}
    </Button>
  );
}
