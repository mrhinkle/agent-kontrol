import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { API_ERRORS } from "../../src/lib/api-error";
import { LABEL_MAX } from "../../src/lib/credentials";
import { LIST_SHAPES, LIST_STATUSES } from "../../src/lib/decisions";
import { PROGRESS_INGEST_KINDS } from "../../src/lib/progress-store";
import { WINDOWS } from "../../src/lib/progress-config";
import { MAX_REPOS } from "../../src/lib/repo-validation";
import { SCOPES } from "../../src/lib/scopes";
import { INGEST_KINDS } from "../../src/lib/store";
import { TASK_STATUSES } from "../../src/lib/types";
import { USAGE_SOURCES } from "../../src/lib/usage-types";
import { USAGE_WINDOWS } from "../../src/lib/usage-window";
import { openApiDocument } from "../../src/lib/openapi";
import { NextRequest } from "next/server";
import { middleware } from "../../src/middleware";

/**
 * CI check for issue #46. `npm run test:ui` runs this file. A new route
 * under src/app/api whose method is missing from the OpenAPI document
 * fails here, and so does a spec entry with no route. HEAD and OPTIONS
 * count the same as GET, POST, PUT, PATCH, and DELETE.
 */

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

function methodSourcePattern(): string {
  return HTTP_METHODS.join("|");
}

type Schema = { properties?: Record<string, unknown>; required?: string[] };

function walkRoutes(dir: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRoutes(full, out);
    else if (entry.name === "route.ts") out.push(full);
  }
}

function exportedMethods(source: string): string[] {
  const methods = new Set<string>();
  const name = methodSourcePattern();
  for (const match of source.matchAll(new RegExp(`export\\s+(?:async\\s+)?function\\s+(${name})\\b`, "g"))) {
    methods.add(match[1]);
  }
  for (const match of source.matchAll(new RegExp(`export\\s+const\\s+(${name})\\b`, "g"))) {
    methods.add(match[1]);
  }
  for (const block of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of block[1].split(",")) {
      const renamed = part.match(new RegExp(`\\bas\\s+(${name})\\b`));
      const bare = part.trim().match(new RegExp(`^(${name})$`));
      if (renamed) methods.add(renamed[1]);
      else if (bare) methods.add(bare[1]);
    }
  }
  return [...methods];
}

function keysMissingFromSpec(urlPath: string, methods: string[], specItem: Record<string, unknown> | undefined): string[] {
  const missing: string[] = [];
  for (const method of methods) {
    if (!specItem?.[method.toLowerCase()]) missing.push(`${method} ${urlPath}`);
  }
  return missing;
}

function keysInSpecWithoutRoute(paths: Record<string, Record<string, unknown>>, fromRoutes: Set<string>): string[] {
  const missing: string[] = [];
  for (const [urlPath, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      if (!item[method.toLowerCase()]) continue;
      const key = `${method} ${urlPath}`;
      if (!fromRoutes.has(key)) missing.push(key);
    }
  }
  return missing;
}

function routePath(file: string): string {
  const rel = file.split(path.sep).join("/");
  const fromApp = rel.slice(rel.indexOf("src/app") + "src/app".length);
  return fromApp.replace(/\/route\.ts$/, "").replace(/\[([^\]]+)\]/g, "{$1}");
}

function interfaceFields(source: string, name: string): { name: string; optional: boolean }[] {
  const start = source.indexOf(`export interface ${name} `);
  assert.notEqual(start, -1, `missing interface ${name}`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let end = brace;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const fields: { name: string; optional: boolean }[] = [];
  for (const line of source.slice(brace + 1, end).split("\n")) {
    const match = line.match(/^\s+([A-Za-z0-9_]+)(\?)?:/);
    if (match) fields.push({ name: match[1], optional: match[2] === "?" });
  }
  return fields;
}

function schemaOf(doc: ReturnType<typeof openApiDocument>, name: string): Schema {
  const schemas = (doc.components as { schemas: Record<string, Schema> }).schemas;
  const schema = schemas[name];
  assert.ok(schema, `missing schema ${name}`);
  return schema;
}

describe("OpenAPI document", () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = {
    password: process.env.MC_DASHBOARD_PASSWORD,
    token: process.env.MC_TOKEN,
    node: process.env.NODE_ENV,
  };

  beforeEach(() => {
    env.MC_DASHBOARD_PASSWORD = "pw";
    env.NODE_ENV = "production";
    delete env.MC_TOKEN;
  });

  afterEach(() => {
    if (saved.password === undefined) delete env.MC_DASHBOARD_PASSWORD;
    else env.MC_DASHBOARD_PASSWORD = saved.password;
    if (saved.token === undefined) delete env.MC_TOKEN;
    else env.MC_TOKEN = saved.token;
    if (saved.node === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = saved.node;
  });

  it("is OpenAPI 3.1 and GET /api/openapi.json returns it without a session", async () => {
    const doc = openApiDocument();
    assert.equal(doc.openapi, "3.1.0");
    assert.equal((doc.info as { version: string }).version.length > 0, true);

    const { GET } = await import("../../src/app/api/openapi.json/route");
    const res = GET();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.openapi, "3.1.0");
    assert.equal(body.paths["/api/tasks"].post.requestBody.content["application/json"].schema.$ref, "#/components/schemas/CreateTask");

    const gated = await middleware(new NextRequest("http://localhost/api/openapi.json"));
    assert.equal(gated.status, 200);
    const api = fs.readFileSync("docs/API.md", "utf8");
    assert.match(api, /\/api\/openapi\.json/);
    assert.match(api, /OpenAPI 3\.1/);
  });

  it("fails when a route is added without a spec entry", () => {
    const files: string[] = [];
    walkRoutes("src/app/api", files);
    assert.ok(files.length >= 20, "the scan found too few route files to be a real check");

    const doc = openApiDocument();
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    const fromRoutes = new Set<string>();
    for (const file of files) {
      const urlPath = routePath(file);
      const methods = exportedMethods(fs.readFileSync(file, "utf8"));
      assert.ok(methods.length > 0, `${file} exports no HTTP method`);
      for (const method of methods) fromRoutes.add(`${method} ${urlPath}`);
      const missing = keysMissingFromSpec(urlPath, methods, paths[urlPath]);
      assert.deepEqual(missing, [], `${missing.join(", ")} is missing from the OpenAPI document (${file})`);
    }

    const extras = keysInSpecWithoutRoute(paths, fromRoutes);
    assert.deepEqual(extras, [], `${extras.join(", ")} is in the spec but no route exports it`);
  });

  it("requires HEAD and OPTIONS coverage in both directions", () => {
    assert.deepEqual(
      exportedMethods("export async function OPTIONS() {}\nexport function HEAD() {}").sort(),
      ["HEAD", "OPTIONS"],
    );
    assert.deepEqual(
      exportedMethods("export const OPTIONS = cors;\nexport const HEAD = head;").sort(),
      ["HEAD", "OPTIONS"],
    );
    assert.deepEqual(
      exportedMethods("export { cors as OPTIONS, head as HEAD };").sort(),
      ["HEAD", "OPTIONS"],
    );
    assert.deepEqual(exportedMethods("export { OPTIONS, HEAD };").sort(), ["HEAD", "OPTIONS"]);

    const missing = keysMissingFromSpec(
      "/api/example",
      exportedMethods("export async function GET() {}\nexport async function OPTIONS() {}\nexport function HEAD() {}"),
      { get: {} },
    );
    assert.deepEqual(missing.sort(), ["HEAD /api/example", "OPTIONS /api/example"]);

    const extras = keysInSpecWithoutRoute(
      { "/api/example": { get: {}, head: {}, options: {} } },
      new Set(["GET /api/example"]),
    );
    assert.deepEqual(extras.sort(), ["HEAD /api/example", "OPTIONS /api/example"]);
  });

  it("marks GET /api/messages agent_id required, matching the handler", () => {
    const doc = openApiDocument();
    const paths = doc.paths as Record<string, { get?: { parameters?: { name: string; required?: boolean }[] } }>;
    const params = paths["/api/messages"]?.get?.parameters ?? [];
    const agentId = params.find((item) => item.name === "agent_id");
    assert.ok(agentId, "GET /api/messages has an agent_id query parameter");
    assert.equal(agentId.required, true);
    assert.equal(params.find((item) => item.name === "ack")?.required, false);
    assert.equal(params.find((item) => item.name === "conversation")?.required, false);
  });

  it("covers POST /api/memory, dry_run, and server-set actor fields", () => {
    const doc = openApiDocument();
    const paths = doc.paths as Record<string, {
      post?: { requestBody?: { content: { "application/json": { schema: { $ref?: string } } } } };
      put?: { requestBody?: { content: { "application/json": { schema: { $ref?: string } } } } };
      patch?: { requestBody?: { content: { "application/json": { schema: { $ref?: string } } } } };
    }>;
    assert.equal(
      paths["/api/memory"]?.post?.requestBody?.content["application/json"].schema.$ref,
      "#/components/schemas/RememberInput",
    );

    const remember = schemaOf(doc, "RememberInput");
    assert.deepEqual(remember.required, ["content"]);
    assert.equal((remember.properties?.dry_run as { type: string }).type, "boolean");
    assert.equal((schemaOf(doc, "PatchTask").properties?.dry_run as { type: string }).type, "boolean");
    assert.equal((schemaOf(doc, "RepoList").properties?.dry_run as { type: string }).type, "boolean");
    assert.equal(paths["/api/tasks/{id}"]?.patch?.requestBody?.content["application/json"].schema.$ref, "#/components/schemas/PatchTask");
    const memoryPost = (doc.paths as Record<string, { post?: { responses?: Record<string, { description?: string }> } }>)["/api/memory"]?.post;
    assert.match(memoryPost?.responses?.["404"]?.description ?? "", /not_found/);
    assert.match(memoryPost?.responses?.["409"]?.description ?? "", /stale_write/);
    assert.equal(paths["/api/settings/repos"]?.put?.requestBody?.content["application/json"].schema.$ref, "#/components/schemas/RepoList");

    const types = fs.readFileSync("src/lib/types.ts", "utf8");
    for (const name of ["Task", "Message"]) {
      const schema = schemaOf(doc, name);
      const fields = interfaceFields(types, name);
      assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), fields.map((field) => field.name).sort());
      assert.deepEqual(schema.required, fields.filter((field) => !field.optional).map((field) => field.name));
      assert.deepEqual((schema.properties?.actor_type as { enum: unknown[] }).enum, ["human", "agent", null]);
      assert.ok(schema.properties?.actor_id);
    }

    const create = schemaOf(doc, "CreateTask");
    assert.equal(create.properties?.actor_type, undefined);
    assert.equal(create.properties?.actor_id, undefined);
  });

  it("builds request schemas from the constants and interfaces the routes use", () => {
    const doc = openApiDocument();
    const report = schemaOf(doc, "ReportInput");
    const reportFields = interfaceFields(fs.readFileSync("src/lib/store.ts", "utf8"), "ReportInput");
    assert.deepEqual(Object.keys(report.properties ?? {}).sort(), reportFields.map((field) => field.name).sort());
    assert.deepEqual(report.required, reportFields.filter((field) => !field.optional).map((field) => field.name));
    assert.deepEqual((report.properties?.kind as { enum: string[] }).enum, [...INGEST_KINDS]);

    const fact = schemaOf(doc, "UsageFact");
    const factFields = interfaceFields(fs.readFileSync("src/lib/usage-types.ts", "utf8"), "UsageFact");
    assert.deepEqual(Object.keys(fact.properties ?? {}).sort(), factFields.map((field) => field.name).sort());
    assert.deepEqual((fact.properties?.source as { enum: string[] }).enum, [...USAGE_SOURCES]);

    const snapshot = schemaOf(doc, "SnapshotInput");
    const snapshotFields = interfaceFields(fs.readFileSync("src/lib/progress-store.ts", "utf8"), "SnapshotInput");
    assert.deepEqual(Object.keys(snapshot.properties ?? {}).sort(), snapshotFields.map((field) => field.name).sort());

    const repo = schemaOf(doc, "RepoInput");
    const repoFields = interfaceFields(fs.readFileSync("src/lib/repo-validation.ts", "utf8"), "RepoInput");
    assert.deepEqual(Object.keys(repo.properties ?? {}).sort(), repoFields.map((field) => field.name).sort());

    const list = schemaOf(doc, "RepoList");
    assert.equal((list.properties?.repos as { maxItems: number }).maxItems, MAX_REPOS);

    const credential = schemaOf(doc, "CreateCredential");
    assert.equal((credential.properties?.label as { maxLength: number }).maxLength, LABEL_MAX);
    assert.deepEqual((credential.properties?.scopes as { items: { enum: string[] } }).items.enum, [...SCOPES]);

    const patch = schemaOf(doc, "PatchTask");
    assert.deepEqual((patch.properties?.status as { enum: string[] }).enum, [...TASK_STATUSES]);

    const paths = doc.paths as Record<string, { get?: { parameters?: { name: string; schema: { enum?: string[] } }[] } }>;
    const progressWindow = paths["/api/progress"].get?.parameters?.find((item) => item.name === "window");
    assert.deepEqual(progressWindow?.schema.enum, [...WINDOWS]);
    const usageWindow = paths["/api/usage"].get?.parameters?.find((item) => item.name === "window");
    assert.deepEqual(usageWindow?.schema.enum, [...USAGE_WINDOWS]);

    const ingest = schemaOf(doc, "ProgressIngest");
    assert.deepEqual((ingest.properties?.kind as { enum: string[] }).enum, [...PROGRESS_INGEST_KINDS]);

    const watched = schemaOf(doc, "WatchedRepo");
    for (const field of ["gone", "shown", "isFork", "isArchived", "lastActivityAt"]) {
      assert.ok(watched.properties?.[field], `WatchedRepo.${field} is documented`);
    }
    const override = schemaOf(doc, "RepoOverride") as Schema & { anyOf?: { required?: string[] }[] };
    const requiredSets = (override.anyOf ?? []).map((item) => item.required ?? []);
    assert.ok(requiredSets.some((fields) => fields.includes("pinned")));
    assert.ok(requiredSets.some((fields) => fields.includes("hidden")));
    const discovery = schemaOf(doc, "OwnerDiscovery");
    const item = (discovery.properties?.results as { items?: { required?: string[]; oneOf?: { $ref?: string }[]; properties?: { repos?: { items?: { properties?: { pushedAt?: { format?: string } } } } } } }).items;
    assert.ok(item?.required?.includes("swept_at"));
    assert.ok(item?.oneOf?.some((entry) => entry.$ref?.endsWith("OwnerDiscoveryOk")));
    const okSchema = schemaOf(doc, "OwnerDiscoveryOk");
    assert.ok(okSchema.required?.includes("repos"));
    assert.equal((okSchema.properties?.ok as { const?: boolean } | undefined)?.const, true);
    const listed = (okSchema.properties?.repos as { items?: { properties?: { pushedAt?: { format?: string } } } } | undefined)?.items;
    assert.equal(listed?.properties?.pushedAt?.format, "date-time");
  });

  it("covers the decisions routes, decisions:write, and the api-error codes", () => {
    const doc = openApiDocument();
    const paths = doc.paths as Record<string, {
      get?: { description?: string; parameters?: { name: string; schema: { enum?: string[] } }[] };
      post?: { description?: string; requestBody?: { content: { "application/json": { schema: { oneOf?: { $ref?: string }[] } } } } };
      patch?: { description?: string; requestBody?: { content: { "application/json": { schema: { $ref?: string } } } } };
    }>;
    const list = paths["/api/decisions"]?.get;
    assert.ok(list, "GET /api/decisions is in the document");
    assert.deepEqual(list.parameters?.find((item) => item.name === "status")?.schema.enum, [...LIST_STATUSES]);
    assert.deepEqual(list.parameters?.find((item) => item.name === "shape")?.schema.enum, [...LIST_SHAPES]);
    assert.match(list.description ?? "", /decisions:write/);

    const post = paths["/api/decisions"]?.post;
    const postRefs = post?.requestBody?.content["application/json"].schema.oneOf?.map((item) => item.$ref);
    assert.deepEqual(postRefs, ["#/components/schemas/DecisionUpsert", "#/components/schemas/DecisionReconcile"]);
    assert.match(post?.description ?? "", /decisions:write/);

    const patch = paths["/api/decisions/{id}"]?.patch;
    assert.equal(patch?.requestBody?.content["application/json"].schema.$ref, "#/components/schemas/PatchDecision");
    assert.match(patch?.description ?? "", /decisions:write/);
    assert.equal((schemaOf(doc, "PatchDecision").properties?.status as { enum: string[] }).enum.includes("decided"), true);

    const decisions = fs.readFileSync("src/lib/decisions.ts", "utf8");
    for (const name of ["Decision", "BriefDecision"]) {
      const schema = schemaOf(doc, name);
      const fields = interfaceFields(decisions, name);
      assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), fields.map((field) => field.name).sort());
      assert.deepEqual(schema.required, fields.filter((field) => !field.optional).map((field) => field.name));
    }

    const code = schemaOf(doc, "Error").properties?.code as { enum: string[] };
    assert.deepEqual(code.enum, [...new Set([...Object.keys(API_ERRORS), "insufficient_scope"])]);
    assert.ok(code.enum.includes("not_found"));
    assert.ok(code.enum.includes("validation_failed"));
    assert.ok(code.enum.includes("idempotency_conflict"));

    const writes = doc.paths as Record<string, { post?: { parameters?: { name: string; in: string }[]; responses?: Record<string, unknown> } }>;
    for (const path of ["/api/tasks", "/api/messages", "/api/messages/reply"]) {
      const params = writes[path]?.post?.parameters ?? [];
      assert.equal(params.some((item) => item.in === "header" && item.name === "Idempotency-Key"), true, path);
      assert.ok(writes[path]?.post?.responses?.["409"], `${path} documents the idempotency conflict`);
    }
    assert.equal(
      (schemaOf(doc, "CreateCredential").properties?.scopes as { items: { enum: string[] } }).items.enum.includes("decisions:write"),
      true,
    );
  });
});
