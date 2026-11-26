import { PortalShell } from "@/features/portal/components/portal-shell";

export default function PortalLayout({ children }: LayoutProps<"/">) {
  return <PortalShell>{children}</PortalShell>;
}
