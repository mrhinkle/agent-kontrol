import { NextRequest, NextResponse } from "next/server";
import { readPublicDoc } from "@/lib/public-docs";

export const dynamic = "force-dynamic";

const PLAIN = { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" };

/**
 * GET /docs/mcp.md, /docs/api.md, /docs/agents.md.
 * Any other name, including traversal, is 404. A missing allowlisted file is 500.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const doc = readPublicDoc(name);
  if (!doc.ok) {
    const body = doc.status === 404 ? "not found" : "document unavailable";
    return new NextResponse(body, { status: doc.status, headers: PLAIN });
  }
  return new NextResponse(doc.body, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
