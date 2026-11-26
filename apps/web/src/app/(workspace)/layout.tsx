import { RequireAuth } from "@/features/auth/components/require-auth";
import { AppShell } from "@/features/workspace/components/app-shell";

/** The guard wraps the whole shell: no header or drawer mounts until auth is confirmed (no flash before /login).
 * Customers only: the API refuses conversations for staff and admins, who are sent to their dashboard instead. */
export default function WorkspaceLayout({ children }: LayoutProps<"/">) {
  return (
    <RequireAuth roles={["customer"]}>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}
