// Generates the fake-microphone fixtures: 48 kHz mono PCM16 WAV files that are silent except for short loud "speech" bursts.
// Chrome plays the file once (--use-file-for-fake-audio-capture=...%noloop). The scripted voice provider treats a loud burst
// followed by silence as one spoken utterance, so burst times decide when the "customer" talks.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RATE = 48_000;

export function makeWav(name: string, bursts: Array<[number, number]>, totalSeconds: number): string {
  const n = RATE * totalSeconds;
  const data = Buffer.alloc(n * 2);
  for (const [start, len] of bursts) {
    for (let i = Math.floor(start * RATE); i < Math.min(n, Math.floor((start + len) * RATE)); i++) {
      const v = Math.sin((2 * Math.PI * 220 * i) / RATE) * 0.6 + Math.sin((2 * Math.PI * 330 * i) / RATE) * 0.2;
      data.writeInt16LE(Math.round(v * 32767), i * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  mkdirSync(__dirname, { recursive: true });
  const path = join(__dirname, name);
  writeFileSync(path, Buffer.concat([h, data]));
  return path;
}

/** "Can you refund my last payment?" at 2 s, then a second utterance at 16 s (after the assistant has finished speaking). */
export const afterSpeech = () => makeWav("mic-after-speech.wav", [[2, 0.6], [16, 0.6]], 40);
/** The second utterance starts at 7.5 s, while the assistant (about 4.5 s to 11 s with the slowed-down scripted voice) is still speaking: a barge-in. */
export const bargeIn = () => makeWav("mic-barge-in.wav", [[2, 0.6], [7.5, 0.6]], 40);
