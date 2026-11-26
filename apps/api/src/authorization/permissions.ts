export const ROLES = ["admin", "staff", "customer"] as const;
export type Role = (typeof ROLES)[number];

/**
 * The permission matrix from the Phase 9 brief. Roles map to permissions; endpoints demand permissions, never role names,
 * so the table below is the single place that defines who can do what. "Own" permissions are additionally checked against
 * the resource (a customer's own tickets, a staff member's assigned ticket) in the services, not just here.
 */
export const PERMISSIONS = [
  "chat.use", "conversations.own",
  "tickets.view_all", "tickets.view_unassigned", "tickets.view_assigned", "tickets.view_own",
  "tickets.claim", "tickets.assign", "tickets.respond", "tickets.resolve", "tickets.note",
  "kb.manage", "staff.manage", "customers.manage", "observability.system", "assignment.configure", "audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  staff: ["conversations.own", "tickets.view_unassigned", "tickets.view_assigned", "tickets.view_own", "tickets.claim", "tickets.respond", "tickets.resolve", "tickets.note"],
  customer: ["chat.use", "conversations.own", "tickets.view_own", "tickets.respond"],
};

export const can = (role: Role, p: Permission): boolean => ROLE_PERMISSIONS[role].includes(p);
