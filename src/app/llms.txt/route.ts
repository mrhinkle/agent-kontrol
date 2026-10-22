import { NextRequest, NextResponse } from "next/server";
import { llmsTxtResponse, readPublicDoc } from "@/lib/public-docs";

export const dynamic = "force-dynamic";

/** GET /llms.txt — public Markdown index. No dashboard session. */
export function GET(req: NextRequest) {
  const res = llmsTxtResponse(req.nextUrl.origin, readPublicDoc("mcp.md"));
  return new NextResponse(res.body, {
    status: res.status,
    headers: {
      "content-type": res.contentType,
      "x-content-type-options": "nosniff",
    },
  });
}
