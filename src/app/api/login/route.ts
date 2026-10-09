import { NextResponse } from "next/server";
import { authCookieValue, secretsMatch } from "@/lib/authcrypto";
import { clientIp } from "@/lib/rate-limit";
import { loginLimiter } from "@/lib/login-limiter";

export async function POST(req: Request) {
  const password = process.env.MC_DASHBOARD_PASSWORD;
  if (!password) {
    return NextResponse.json({ ok: true, note: "no password configured" });
  }

  const ip = clientIp(req);
  const { allowed, retryAfterSec } = loginLimiter.check(ip);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts" }, { status: 429, headers: { "Retry-After": String(retryAfterSec) } });
  }

  // Reserve the attempt synchronously (no await between check and fail) so a
  // concurrent burst cannot pass the check before the attempt is recorded.
  loginLimiter.fail(ip);

  let submitted = "";
  try {
    const body = (await req.json()) as { password?: string };
    submitted = body.password ?? "";
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  if (!(await secretsMatch(submitted, password))) {
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }

  // Correct password: release the reservation.
  loginLimiter.reset(ip);

  const res = NextResponse.json({ ok: true });
  res.cookies.set("mc_auth", await authCookieValue(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
