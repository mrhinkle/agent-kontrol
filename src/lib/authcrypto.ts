/**
 * Edge-safe auth crypto helpers (Web Crypto only — works in middleware,
 * edge, and Node 18+ route handlers).
 *
 * Secret comparisons hash both sides first, so string comparison timing
 * reveals nothing about the secret itself.
 */

const enc = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-safe secret comparison: compare digests, not secrets. */
export async function secretsMatch(candidate: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(`cmp:${candidate}`), sha256Hex(`cmp:${secret}`)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Dashboard auth cookie: HMAC-SHA256 keyed by a server secret
 * (MC_COOKIE_SECRET, falling back to MC_TOKEN, falling back to the password
 * itself). A leaked cookie can't be reversed to the password without the
 * key; rotating any of those envs revokes all sessions.
 */
export async function authCookieValue(password: string): Promise<string> {
  const keyMaterial =
    process.env.MC_COOKIE_SECRET || process.env.MC_TOKEN || `pw-only:${password}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`mc-cookie-v1:${password}`));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── OAuth / JWT / PKCE (Web Crypto only) ───────────────────────────────────

function oauthSigningKey(): string {
  const key =
    process.env.MC_OAUTH_SECRET || process.env.MC_COOKIE_SECRET || process.env.MC_TOKEN;
  if (key) return key;
  // Never sign with a public constant in production — that makes tokens forgeable.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "OAuth signing key missing: set MC_OAUTH_SECRET (or MC_COOKIE_SECRET / MC_TOKEN) in production."
    );
  }
  return "dev-oauth-signing-key";
}

/** Base64url without padding (JWT / PKCE). */
export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlFromString(s: string): string {
  return base64url(enc.encode(s));
}

function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(oauthSigningKey()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Cryptographically random base64url token (auth codes, client_ids, etc.). */
export function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64url(arr);
}

/**
 * PKCE S256: base64url(SHA-256(verifier)) === challenge (no padding).
 * Uses constant-time comparison of the challenge strings.
 */
export async function pkceS256Matches(verifier: string, challenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
  const computed = base64url(digest);
  return secretsMatch(computed, challenge);
}

export type JwtPayload = {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  sub: string;
  client_id: string;
  scope: string;
  /** "access" (default) or "refresh" */
  typ?: string;
};

/**
 * Compact JWS (HS256) access/refresh token.
 * Payload includes iss, aud, exp, iat, sub, client_id, scope.
 */
export async function signAccessToken(
  payload: Omit<JwtPayload, "exp" | "iat"> & { typ?: string },
  ttlSeconds: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const full: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  };
  const header = base64urlFromString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64urlFromString(JSON.stringify(full));
  const data = `${header}.${body}`;
  const key = await hmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${base64url(sig)}`;
}

/**
 * Verify HS256 JWT signature + exp. Returns payload or null.
 * Signature comparison is constant-time via secretsMatch on base64url forms.
 */
export async function verifyAccessToken(token: string): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, bodyB64, sigB64] = parts as [string, string, string];
  if (!headerB64 || !bodyB64 || !sigB64) return null;

  let header: { alg?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerB64))) as {
      alg?: string;
    };
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  const data = `${headerB64}.${bodyB64}`;
  const key = await hmacKey();
  const expected = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const expectedB64 = base64url(expected);
  if (!(await secretsMatch(sigB64, expectedB64))) return null;

  let payload: JwtPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(bodyB64))) as JwtPayload;
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  if (typeof payload.client_id !== "string" || typeof payload.sub !== "string") {
    return null;
  }
  return payload;
}
