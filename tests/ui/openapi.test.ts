import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LABEL_MAX } from "../../src/lib/credentials";
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
 * fails here, and so does a spec entry with no route.
 */

const HTTP = ["get", "post", "put", "patch", "delete"] as const;

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
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
    methods.add(match[1]);
  }
  for (const match of source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
    methods.add(match[1]);
  }
  for (const block of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of block[1].split(",")) {
      const renamed = part.match(/\bas\s+(GET|POST|PUT|PATCH|DELETE)\b/);
      const bare = part.trim().match(/^(GET|POST|PUT|PATCH|DELETE)$/);
      if (renamed) methods.add(renamed[1]);
      else if (bare) methods.add(bare[1]);
    }
  }
  return [...methods];
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
      for (const method of methods) {
        const key = `${method} ${urlPath}`;
        fromRoutes.add(key);
        const item = paths[urlPath];
        assert.ok(item, `${key} is missing from the OpenAPI document (${file})`);
        assert.ok(item[method.toLowerCase()], `${key} is missing from the OpenAPI document (${file})`);
      }
    }

    for (const [urlPath, item] of Object.entries(paths)) {
      for (const method of HTTP) {
        if (!item[method]) continue;
        const key = `${method.toUpperCase()} ${urlPath}`;
        assert.ok(fromRoutes.has(key), `${key} is in the spec but no route exports it`);
      }
    }
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
  });
});
