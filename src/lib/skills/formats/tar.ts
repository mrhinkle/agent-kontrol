import { gzipSync } from "node:zlib";
import { isSafeArchivePath } from "./paths";

/**
 * ustar + gzip. Paths are the sanitized archive names. A path that fails the
 * check is not written, even if a caller passed it through.
 */

const NAME_MAX = 100;
const PREFIX_MAX = 155;

export function tarGzip(files: { path: string; content: string }[]): Buffer {
  const chunks: Buffer[] = [];
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    if (!isSafeArchivePath(file.path)) continue;
    const split = splitPath(file.path);
    if (!split) continue;
    const body = Buffer.from(file.content, "utf8");
    chunks.push(header(split.name, split.prefix, body.length));
    chunks.push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function splitPath(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path) <= NAME_MAX) return { name: path, prefix: "" };
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return null;
  const name = path.slice(slash + 1);
  const prefix = path.slice(0, slash);
  if (Buffer.byteLength(name) > NAME_MAX || Buffer.byteLength(prefix) > PREFIX_MAX) return null;
  if (!isSafeArchivePath(name) || !isSafeArchivePath(prefix)) return null;
  return { name, prefix };
}

function header(name: string, prefix: string, size: number): Buffer {
  const buf = Buffer.alloc(512, 0);
  buf.write(name, 0, NAME_MAX, "utf8");
  writeOctal(buf, 100, 0o644, 8);
  writeOctal(buf, 108, 0, 8);
  writeOctal(buf, 116, 0, 8);
  writeOctal(buf, 124, size, 12);
  writeOctal(buf, 136, 0, 12);
  for (let i = 148; i < 156; i += 1) buf[i] = 0x20;
  buf[156] = "0".charCodeAt(0);
  buf.write("ustar", 257, 5, "ascii");
  buf[262] = 0;
  buf.write("00", 263, 2, "ascii");
  if (prefix) buf.write(prefix, 345, PREFIX_MAX, "utf8");
  let sum = 0;
  for (const byte of buf) sum += byte;
  const checksum = sum.toString(8).padStart(6, "0");
  buf.write(checksum, 148, 6, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

function writeOctal(buf: Buffer, offset: number, value: number, length: number): void {
  const digits = value.toString(8).padStart(length - 1, "0");
  buf.write(digits, offset, length - 1, "ascii");
  buf[offset + length - 1] = 0;
}
