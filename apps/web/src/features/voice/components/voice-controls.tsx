import { Hand, Mic, MicOff, PhoneOff, Square } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { VoiceState } from "../types";

interface Props {
  state: VoiceState;
  onMute: (m: boolean) => void;
  onEnd: () => void;
  onInterrupt: () => void;
  onPushToTalk: (v: boolean) => void;
  onHold: (held: boolean) => void;
}

export function VoiceControls({ state, onMute, onEnd, onInterrupt, onPushToTalk, onHold }: Props) {
  const live = state.connectionStatus === "connected";
  const canInterrupt = live && (state.activity === "assistant_speaking" || state.activity === "processing");
  const holdEnabled = live && state.pushToTalk && !state.isMuted;

  // Space anywhere on the page talks while push to talk is on, except while typing in a field.
  useEffect(() => {
    if (!holdEnabled) return;
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e.target)) return;
      e.preventDefault(); // no page scroll, no button click
      if (!e.repeat) onHold(true);
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space" && !typing(e.target)) { e.preventDefault(); onHold(false); } };
    const release = () => onHold(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release); // tabbing away mid-hold must not leave the mic open
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", release); };
  }, [holdEnabled, onHold]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {state.pushToTalk ? (
        <Button
          type="button" variant="outline" size="sm" data-testid="voice-hold" disabled={!live || state.isMuted}
          className="touch-none select-none" onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); onHold(true); }}
          onPointerUp={() => onHold(false)} onPointerCancel={() => onHold(false)} onLostPointerCapture={() => onHold(false)}
        >
          <Hand /> Hold to talk <kbd className="ml-1 rounded border border-border px-1 text-[10px] text-faint">Space</kbd>
        </Button>
      ) : (
        <Button type="button" variant="outline" size="sm" data-testid="voice-mute" aria-pressed={state.isMuted} disabled={!live} onClick={() => onMute(!state.isMuted)}>
          {state.isMuted ? <MicOff /> : <Mic />} {state.isMuted ? "Unmute" : "Mute"}
        </Button>
      )}
      {canInterrupt && <Button type="button" variant="outline" size="sm" data-testid="voice-interrupt" onClick={onInterrupt}><Square /> Stop speaking</Button>}
      <div className="flex items-center gap-1.5">
        <Checkbox id="voice-ptt" data-testid="voice-ptt" checked={state.pushToTalk} disabled={!live} onCheckedChange={(v) => onPushToTalk(v === true)} />
        <Label htmlFor="voice-ptt" className="text-xs font-normal text-faint">Push to talk</Label>
      </div>
      <Button type="button" variant="ghost" size="sm" className="ml-auto" data-testid="voice-end" onClick={onEnd}><PhoneOff /> End voice</Button>
    </div>
  );
}
