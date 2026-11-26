import type { VoiceDiagnostics } from "../../types";
import { ms, usd } from "../../format";
import { MetricCard } from "../metric-card";

export function VoiceDiagnosticsPanel({ d }: { d: VoiceDiagnostics }) {
  const m = d.metrics;
  return (
    <div className="space-y-3" data-testid="voice-diagnostics">
      <p className="text-xs text-faint">{d.model} · {d.status}{d.endReason ? ` (${d.endReason})` : ""}</p>
      <div className="grid grid-cols-2 gap-2">
        <MetricCard testId="v-setup" label="Connection setup" value={ms(m.connectionSetupMs)} />
        <MetricCard testId="v-first-audio" label="First audio (server)" value={ms(m.timeToFirstAudioMs)} hint={`Heard in the browser: ${ms(m.timeToFirstPlaybackMs)}`} />
        <MetricCard label="Interruption processing" value={ms(m.interruptionLatencyMs)} hint={`${m.interruptions ?? 0} interruption${m.interruptions === 1 ? "" : "s"}`} />
        <MetricCard label="WebSocket RTT" value={ms(m.rttMs)} hint="Reported by the browser" />
        <MetricCard label="Reconnect attempts" value={String(m.reconnectAttempts ?? 0)} />
        <MetricCard label="Dropped frames" value={String(m.droppedFrames ?? 0)} hint={`${m.staleAudioDropped ?? 0} stale audio frames`} />
        <MetricCard label="Audio in / out" value={d.audioSeconds ? `${d.audioSeconds.input}s / ${d.audioSeconds.output}s` : "n/a"} />
        <MetricCard label="Duplicate delegated turns" value={String(d.functionCalls.duplicates)} hint={`${d.functionCalls.total} delegated calls`} />
      </div>
      <p className="text-xs text-ink" data-testid="voice-cost">Live session cost: <strong>{usd(d.cost?.estimatedCostUsd)}</strong> <span className="text-faint">(session-level; Live usage is not reported per turn){d.cost?.pricingVersion ? ` · ${d.cost.pricingVersion}` : ""}</span></p>
      {d.turns.length > 0 && (
        <table className="w-full text-xs"><thead><tr className="text-left text-faint"><th className="py-1 font-normal">Turn</th><th className="font-normal">First audio</th><th className="font-normal">Grounding</th><th className="font-normal">Interrupted</th></tr></thead>
          <tbody>{d.turns.map((t, i) => <tr key={t.turnId} className="border-t border-rule" data-testid="voice-turn"><td className="py-1">{i + 1}</td><td className="tabular-nums">{ms(t.firstAudioMs)}</td><td>{t.grounding}</td><td>{t.interrupted ? "yes" : "no"}</td></tr>)}</tbody></table>
      )}
      {d.events.length > 0 && <p className="text-xs text-faint">{d.events.map((e) => `${e.name.replace("voice.", "")} ${ms(e.durationMs)}`).join(" · ")}</p>}
    </div>
  );
}
