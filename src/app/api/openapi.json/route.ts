import { NextResponse } from "next/server";
import { openApiDocument } from "@/lib/openapi";

/**
 * GET /api/openapi.json
 * Public OpenAPI 3.1 document. It describes the REST routes and contains
 * no secrets, so it stays outside the dashboard gate the same way
 * GET /docs/api.md does.
 */
export function GET() {
  return NextResponse.json(openApiDocument());
}
