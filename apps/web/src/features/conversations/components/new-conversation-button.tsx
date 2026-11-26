import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export function NewConversationButton({ onClick, loading }: { onClick: () => void; loading?: boolean }) {
  return (
    <Button variant="outline" className="w-full justify-start" onClick={onClick} loading={loading} data-testid="new-conversation">
      <Plus /> New conversation
    </Button>
  );
}
