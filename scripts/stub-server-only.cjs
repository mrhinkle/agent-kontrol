/**
 * UI tests run under tsx, which loads TypeScript as CommonJS. Next aliases
 * `server-only` to an empty module for server builds; this preload does the
 * same for `require("server-only")` so those tests can import server modules.
 */
const Module = require("module");
const path = require("path");

const empty = path.join(__dirname, "stub-server-only-empty.cjs");
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") return empty;
  return resolveFilename.call(this, request, parent, isMain, options);
};
