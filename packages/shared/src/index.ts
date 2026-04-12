import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

export const HealthResponse = z.object({
  ok: z.literal(true),
  service: z.string(),
  version: z.string(),
  env: z.enum(['development', 'production', 'test']),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

export const SignupRequest = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(255),
  name: z.string().min(1).max(100),
  workspaceName: z.string().min(1).max(100),
});
export type SignupRequest = z.infer<typeof SignupRequest>;

export const LoginRequest = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(255),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const AuthUser = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: z.string(),
  workspaceId: z.number().int(),
});
export type AuthUser = z.infer<typeof AuthUser>;

export const AuthMeResponse = z.object({
  user: AuthUser.nullable(),
});
export type AuthMeResponse = z.infer<typeof AuthMeResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Mailboxes
// ─────────────────────────────────────────────────────────────────────────────

export const MailboxProvider = z.enum(['google', 'microsoft', 'smtp']);
export type MailboxProvider = z.infer<typeof MailboxProvider>;

export const MailboxPool = z.enum(['primed', 'ramping', 'resting']);
export type MailboxPool = z.infer<typeof MailboxPool>;

export const MailboxHealthStatus = z.enum([
  'connected',
  'disconnected',
  'paused',
  'bouncing',
]);
export type MailboxHealthStatus = z.infer<typeof MailboxHealthStatus>;

export const MailboxView = z.object({
  id: z.number().int(),
  email: z.string(),
  displayName: z.string().nullable(),
  provider: MailboxProvider,
  pool: MailboxPool,
  healthStatus: MailboxHealthStatus,
  healthScore: z.number().int(),
  dailyLimitTarget: z.number().int(),
  dailyLimitCurrent: z.number().int(),
  /** Basis points: 200 = 2.00% */
  bounceRate30dBps: z.number().int(),
  /** Basis points: 30 = 0.30% */
  spamComplaintRate30dBps: z.number().int(),
  spfOk: z.boolean().nullable(),
  dkimOk: z.boolean().nullable(),
  dmarcOk: z.boolean().nullable(),
  mxOk: z.boolean().nullable(),
  warmupEnabled: z.boolean(),
  pauseReason: z.string().nullable(),
  restingUntil: z.string().nullable(),
  rampStartedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MailboxView = z.infer<typeof MailboxView>;

export const MailboxListResponse = z.object({
  mailboxes: z.array(MailboxView),
});
export type MailboxListResponse = z.infer<typeof MailboxListResponse>;

export const MailboxDetailResponse = z.object({
  mailbox: MailboxView,
});
export type MailboxDetailResponse = z.infer<typeof MailboxDetailResponse>;

// Daily snapshot row exposed to the frontend (no placement/spam internals).
export const MailboxHealthSnapshotView = z.object({
  date: z.string(), // 'YYYY-MM-DD'
  pool: MailboxPool,
  healthScore: z.number().int(),
  bounceRate30dBps: z.number().int(),
  spamRate30dBps: z.number().int(),
  sendsCount: z.number().int(),
  bouncesCount: z.number().int(),
  effectiveDailyLimit: z.number().int(),
});
export type MailboxHealthSnapshotView = z.infer<typeof MailboxHealthSnapshotView>;

export const MailboxHealthHistoryResponse = z.object({
  snapshots: z.array(MailboxHealthSnapshotView),
});
export type MailboxHealthHistoryResponse = z.infer<typeof MailboxHealthHistoryResponse>;

export const HealthRunResult = z.object({
  mailboxId: z.number().int(),
  email: z.string(),
  previousPool: MailboxPool,
  newPool: MailboxPool,
  previousLimit: z.number().int(),
  newLimit: z.number().int(),
  healthScore: z.number().int(),
  bounceRateBps: z.number().int(),
  spamRateBps: z.number().int(),
  reason: z.string(),
});
export type HealthRunResult = z.infer<typeof HealthRunResult>;
