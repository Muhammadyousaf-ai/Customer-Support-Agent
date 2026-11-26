"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { ConnectionStatus } from "@/features/feedback/components/connection-status";
import { ErrorMessage } from "@/features/feedback/components/error-message";
import { useVoice } from "@/features/voice/hooks/use-voice";
import { VoiceToggle } from "@/features/voice/components/voice-toggle";
import { VoiceWorkspace } from "@/features/voice/components/voice-workspace";
import { useChat } from "../hooks/use-chat";
import { useEventStream } from "../hooks/use-event-stream";
import { useChatStore } from "../store/chat.store";
import { ChatHeader } from "./chat-header";
import { EmptyChat } from "./empty-chat";
import { MessageComposer } from "./message-composer";
import { HandoverBanner } from "./handover-banner";
import { MessageList } from "./message-list";

interface Props {
  conversation: { id: string; token: string };
  title: string;
  onOpenSidebar: () => void;
  onUnavailable: () => void;
}

export function ChatWorkspace({ conversation, title, onOpenSidebar, onUnavailable }: Props) {
  useEventStream(conversation, onUnavailable);
  const chat = useChat(conversation);
  const voice = useVoice(conversation);
  const voiceBusy = voice.state.connectionStatus === "connecting";
  const runs = useChatStore((s) => s.events.runs);

  // Reconcile: once a persisted message matches an optimistic one, the optimistic copy disappears.
  const failed = chat.optimistic.find((m) => m.status === "failed");
  const empty = !chat.messagesLoading && chat.messages.length === 0 && chat.optimistic.length === 0 && !chat.run;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader title={title} onOpenSidebar={onOpenSidebar} actions={<VoiceToggle active={voice.active && voice.state.connectionStatus !== "failed"} busy={voiceBusy} onToggle={() => void (voice.active ? voice.end() : voice.start())} />} />
      <ConnectionStatus />
      <HandoverBanner conversation={conversation} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {chat.messagesLoading ? (
          <div className="mx-auto w-full max-w-3xl space-y-3 px-6 py-6"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-16 w-full" /></div>
        ) : empty ? (
          <EmptyChat onPick={(t) => void chat.send(t)} disabled={chat.submitting} />
        ) : (
          <MessageList
            messages={chat.messages}
            optimistic={chat.optimistic}
            runs={runs}
            activeRun={chat.run}
            acting={chat.acting}
            onConfirm={() => void chat.confirm()}
            onDecline={() => void chat.decline()}
            onRetry={(id, text) => void chat.send(text, id)}
          />
        )}
        {chat.run?.status === "failed" && chat.run.error && (
          <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
            <ErrorMessage error={{ kind: "server", message: chat.run.error.message, retryable: false }} />
          </div>
        )}
        {chat.messagesError && (
          <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
            <ErrorMessage error={{ kind: "network", message: "Couldn't load this conversation.", retryable: true }} onRetry={chat.refresh} />
          </div>
        )}
        {chat.error && !failed && (
          <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
            <ErrorMessage error={chat.error} onDismiss={chat.clearError} />
          </div>
        )}
      </div>
      <VoiceWorkspace voice={voice} />
      <MessageComposer runStatus={chat.runStatus} submitting={chat.submitting} onSend={chat.send} onStop={() => void chat.stop()} />
    </div>
  );
}
