import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from "mcp-handler";
import { issuer, resource } from "@/lib/oauth";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 * Advertises this MCP server as a resource and points clients at our AS.
 */
export async function GET(req: Request) {
  const iss = issuer(req);
  const handler = protectedResourceHandler({
    authServerUrls: [iss],
    resourceUrl: resource(req),
  });
  return handler(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
