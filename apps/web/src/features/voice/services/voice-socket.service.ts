import { decodeAudioFrame, type VoiceClientMessage, type VoiceEvent } from "@support-ai/contracts";

export interface VoiceSocket {
  send(message: VoiceClientMessage): void;
  sendAudio(pcm: ArrayBuffer): void;
  close(): void;
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
}

export interface SocketHandlers {
  onOpen: () => void;
  onEvent: (e: VoiceEvent) => void;
  onAudio: (frame: { generationId: number; sequence: number; pcm: Uint8Array }) => void;
  onClose: (code: number) => void;
}

export type SocketFactory = (url: string, ticket: string, handlers: SocketHandlers) => VoiceSocket;

/**
 * Browser WebSocket to /ws/voice. The single-use ticket travels in the subprotocol, not the URL, so it is not logged.
 * Binary frames in are assistant PCM with a generation/sequence header; binary frames out are raw microphone PCM.
 */
export const openVoiceSocket: SocketFactory = (url, ticket, h) => {
  const ws = new WebSocket(url, ["voice.v1", `ticket.${ticket}`]);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => h.onOpen();
  ws.onclose = (e) => h.onClose(e.code);
  ws.onerror = () => undefined; // onclose always follows and carries the outcome
  ws.onmessage = (m: MessageEvent<string | ArrayBuffer>) => {
    if (typeof m.data === "string") {
      try { h.onEvent(JSON.parse(m.data) as VoiceEvent); } catch { /* ignore a malformed server message */ }
    } else {
      const f = decodeAudioFrame(m.data);
      if (f) h.onAudio(f);
    }
  };
  return {
    send: (message) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); },
    sendAudio: (pcm) => { if (ws.readyState === WebSocket.OPEN) ws.send(pcm); },
    close: () => { try { ws.close(1000); } catch { /* ignore */ } },
    get bufferedAmount() { return ws.bufferedAmount; },
    get isOpen() { return ws.readyState === WebSocket.OPEN; },
  };
};
