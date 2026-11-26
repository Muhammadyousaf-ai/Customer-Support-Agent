"use client";

import { useEffect, useRef } from "react";
import type { VoiceActivity, VoiceConnectionStatus } from "../types";

interface Props {
  getAnalyser: () => AnalyserNode | null;
  activity: VoiceActivity;
  connection: VoiceConnectionStatus;
  muted: boolean;
}

const BARS = 48;

/**
 * Draws real amplitude from an AnalyserNode (the microphone while listening, the assistant's output while it speaks)
 * with requestAnimationFrame. Nothing here goes through React state per frame. Muted and disconnected are flat lines;
 * processing is a neutral, clearly synthetic animation.
 */
export function VoiceWaveform({ getAnalyser, activity, connection, muted }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ getAnalyser, activity, connection, muted });
  useEffect(() => { live.current = { getAnalyser, activity, connection, muted }; });

  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext("2d");
    if (!el || !g) return;
    let raf = 0;
    let data: Uint8Array<ArrayBuffer> | null = null;
    const draw = (t: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth, h = el.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.fillStyle = getComputedStyle(el).color;
      const { getAnalyser: ga, activity: a, connection: c, muted: m } = live.current;
      const gap = 3, bw = Math.max(2, w / BARS - gap), mid = h / 2;
      const flat = c !== "connected" || m;
      const analyser = flat ? null : ga();
      let levels: number[] = new Array(BARS).fill(0);
      if (a === "processing" && !flat) {
        levels = levels.map((_, i) => 0.12 + 0.1 * Math.sin(t / 260 + i / 3));
      } else if (analyser) {
        if (!data || data.length !== analyser.fftSize) data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        const seg = Math.floor(data.length / BARS);
        levels = levels.map((_, i) => {
          let sum = 0;
          for (let k = 0; k < seg; k++) { const v = (data![i * seg + k]! - 128) / 128; sum += v * v; }
          return Math.min(1, Math.sqrt(sum / seg) * 3.2);
        });
      }
      for (let i = 0; i < BARS; i++) {
        const bh = Math.max(2, levels[i]! * h * 0.9);
        g.globalAlpha = flat ? 0.3 : 0.85;
        g.fillRect(i * (bw + gap), mid - bh / 2, bw, bh);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvas} data-testid="voice-waveform" aria-hidden className="h-12 w-full text-ink" />;
}
