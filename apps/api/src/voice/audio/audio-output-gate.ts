/**
 * Native-audio output is only allowed to reach the browser once the backend has a verified answer for the current
 * turn. Audio the model produces before that (it answered on its own, skipping delegation) is dropped and counted;
 * the orchestrator then runs delegation itself and asks the model to speak the approved text.
 *
 * "Closed" is the default: a new customer turn, an interruption and a reconnect all close the gate.
 */
export class AudioOutputGate {
  private openFor: string | null = null;
  private gatedBytes = 0;
  private gatedFrames = 0;

  open(turnId: string): void {
    this.openFor = turnId;
  }

  close(): void {
    this.openFor = null;
  }

  isOpenFor(turnId: string | undefined): boolean {
    return this.openFor !== null && this.openFor === turnId;
  }

  /** Returns true when the frame may be forwarded to the browser. */
  admit(turnId: string | undefined, bytes: number): boolean {
    if (this.isOpenFor(turnId)) return true;
    this.gatedBytes += bytes;
    this.gatedFrames += 1;
    return false;
  }

  stats() {
    return { gatedBytes: this.gatedBytes, gatedFrames: this.gatedFrames };
  }
}
