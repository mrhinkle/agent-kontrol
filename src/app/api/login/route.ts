import { NextResponse } from "next/server";
import { authCookieValue, secretsMatch } from "@/lib/authcrypto";

export async function POST(req: Request) {
  const password = process.env.MC_DASHBOARD_PASSWORD;
  if (!password) {
    return NextResponse.json({ ok: true, note: "no password configured" });
  }

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
