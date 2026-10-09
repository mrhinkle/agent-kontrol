import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from "mcp-handler";
import { issuer, resource } from "@/lib/oauth";

/**
 * Per-resource protected resource metadata path
 * (/.well-known/oauth-protected-resource/api/mcp).
 * Some clients look up metadata by resource path rather than the root document.
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
