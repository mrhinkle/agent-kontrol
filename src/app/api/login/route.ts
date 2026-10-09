import { NextResponse } from "next/server";
import { authCookieValue, secretsMatch } from "@/lib/authcrypto";
import { clientIp, createLimiter } from "@/lib/rate-limit";

const limiter = createLimiter({ max: 5, windowMs: 10 * 60 * 1000 });

export async function POST(req: Request) {
  const password = process.env.MC_DASHBOARD_PASSWORD;
  if (!password) {
    return NextResponse.json({ ok: true, note: "no password configured" });
  }

  const ip = clientIp(req);
  const { allowed, retryAfterSec } = limiter.check(ip);
  if (!allowed) {
    return NextResponse.json(
      { error: "too many attempts" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
    );
  }

  let submitted = "";
  try {
    const body = (await req.json()) as { password?: string };
    submitted = body.password ?? "";
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  if (!(await secretsMatch(submitted, password))) {
    limiter.fail(ip);
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }

  limiter.reset(ip);

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
