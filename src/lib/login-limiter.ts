import { createLimiter } from "./rate-limit";

/**
 * Shared login-attempt limiter: one budget of 5 attempts per 10-minute window
 * per client IP, drawn from by both the dashboard login route and the OAuth
 * authorize consent form so both entrances share a single per-client budget.
 *
 * In-memory and per-instance only — see rate-limit.ts.
 */
export const loginLimiter = createLimiter({ max: 5, windowMs: 10 * 60 * 1000 });
