import { z } from "zod";

/** Phase 9 wire contracts: accounts, roles, tickets, knowledge-base management. Shared by the API and the web app. */
export const ROLES = ["admin", "staff", "customer"] as const;
export type Role = (typeof ROLES)[number];
export const USER_STATUSES = ["pending_verification", "invited", "active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10, "Password must be at least 10 characters.").max(128, "Password is too long.")
  .refine((p) => /[a-z]/i.test(p) && /\d/.test(p), "Password must contain letters and at least one digit.");
const nameSchema = z.string().trim().min(1).max(80);

export const registerSchema = z.object({ email: emailSchema, password: passwordSchema, displayName: nameSchema }).strict();
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
export const refreshSchema = z.object({ refreshToken: z.string().min(10).max(200) }).strict();
export const logoutSchema = z.object({ refreshToken: z.string().min(10).max(200).optional() }).strict();
export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();
export const tokenPasswordSchema = z.object({ token: z.string().min(10).max(200), password: passwordSchema }).strict();
export const verifyEmailSchema = z.object({ token: z.string().min(10).max(200) }).strict();
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict();
export const createStaffSchema = z.object({ email: emailSchema, displayName: nameSchema }).strict();

export interface PublicUser { id: string; email: string; role: Role; status: UserStatus; displayName: string; emailVerified: boolean; customerId: string | null; createdAt: string; lastLoginAt: string | null }
export interface AuthTokens { accessToken: string; refreshToken: string; expiresIn: number; user: PublicUser }

// ---- tickets -------------------------------------------------------------------------------------------------------------
export const TICKET_STATUSES = ["open", "assigned", "in_progress", "waiting_customer", "pending_review", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_CATEGORIES = ["billing", "refund", "account", "technical", "other"] as const;
export const HANDOVER_MODES = ["AI_ACTIVE", "WAITING_FOR_STAFF", "HUMAN_ACTIVE"] as const;
export type HandoverMode = (typeof HANDOVER_MODES)[number];
export const ASSIGNMENT_MODES = ["manual", "round_robin", "workload"] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];

export const ticketMessageSchema = z.object({ body: z.string().trim().min(1).max(4000) }).strict();
export const ticketNoteSchema = ticketMessageSchema;
export const ticketStatusSchema = z.object({ status: z.enum(TICKET_STATUSES), note: z.string().trim().max(500).optional() }).strict();
export const ticketResolveSchema = z.object({ resolution: z.string().trim().min(1).max(2000) }).strict();
export const ticketPrioritySchema = z.object({ priority: z.enum(TICKET_PRIORITIES) }).strict();
export const ticketAssignSchema = z.object({ staffId: z.string().uuid().nullable() }).strict();
export const ticketCreateSchema = z.object({ subject: z.string().trim().min(3).max(120), description: z.string().trim().min(1).max(4000), category: z.enum(TICKET_CATEGORIES).default("other"), priority: z.enum(TICKET_PRIORITIES).default("normal") }).strict();
export const assignmentModeSchema = z.object({ mode: z.enum(ASSIGNMENT_MODES) }).strict();

/** What the status machine allows (also enforced by the API; the UI uses it to offer only valid actions). */
export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ["assigned"],
  assigned: ["in_progress", "waiting_customer", "pending_review", "resolved", "open"],
  in_progress: ["waiting_customer", "pending_review", "resolved", "assigned"],
  waiting_customer: ["in_progress", "resolved"],
  pending_review: ["in_progress", "resolved"],
  resolved: ["closed", "in_progress"],
  closed: ["in_progress"],
};

export interface TicketSummary {
  id: string; subject: string; category: string; priority: TicketPriority; status: TicketStatus; source: string; reason: string;
  createdAt: string; updatedAt: string; assignedStaff: { id: string; displayName: string } | null; aiSummary: string | null;
  /** Present for the customer and for staff/admin who may see them; unassigned tickets show staff a reduced view without these. */
  customer?: { id: string | null; displayName: string | null; email: string | null };
}
export interface TicketMessageView { id: number; authorKind: "customer" | "staff" | "system"; authorName: string | null; body: string; createdAt: string }
export interface TicketNoteView { id: number; authorName: string; body: string; createdAt: string }
export interface TicketDetail extends TicketSummary {
  description: string | null; sessionId: string; resolution: string | null; resolvedAt: string | null; firstResponseAt: string | null;
  messages: TicketMessageView[];
  /** Internal: staff and admin only. */
  notes?: TicketNoteView[];
  history: Array<{ from: string | null; to: string; by: string | null; note: string | null; at: string }>;
  assignments?: Array<{ staff: string | null; by: string | null; method: string; at: string }>;
  /** The AI conversation that led here (staff/admin only, assigned or admin). */
  transcript?: Array<{ role: string; author: string; mode: string; content: string; at: string }>;
  allowedTransitions: TicketStatus[];
}

// ---- knowledge base ----------------------------------------------------------------------------------------------------------
export const kbSourceSchema = z.object({ source: z.string().min(20).max(200_000) }).strict();
export const kbTestSchema = z.object({ query: z.string().trim().min(2).max(500), tier: z.enum(["free", "basic", "pro", "enterprise"]).optional(), contractType: z.enum(["monthly", "annual"]).optional() }).strict();
