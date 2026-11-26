import { AudioLines, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function VoiceToggle({ active, busy, onToggle }: { active: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <Button variant={active ? "secondary" : "outline"} size="sm" className="ml-auto" aria-pressed={active} aria-label={active ? "End voice" : "Start voice"} data-testid="voice-toggle" disabled={busy} onClick={onToggle}>
      {busy ? <Loader2 className="animate-spin" /> : <AudioLines />} Voice
    </Button>
  );
}
