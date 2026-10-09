import {
  CanvasTexture,
  LinearFilter,
  LinearSRGBColorSpace,
  RepeatWrapping,
} from "three";

export const DATAFACE_WIDTH = 256;
export const DATAFACE_HEIGHT = 1024;

const HEX_GLYPHS = "0123456789ABCDEF";
const ASCII_GLYPHS = "01<>/\\|[]{}#$%*+=-_.";

/** FNV-1a 32-bit — deterministic seed, never Math.random. */
export function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DataFaceSource {
  id: string;
  label: string;
  titles: readonly string[];
  platforms: readonly string[];
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function pickGlyph(rand: () => number, alphabet: string): string {
  return alphabet[Math.floor(rand() * alphabet.length)] ?? "0";
}

function collectLedger(source: DataFaceSource): string[] {
  const tokens: string[] = [];
  const pushParts = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    tokens.push(trimmed);
    for (const part of trimmed.split(/[\s/|_-]+/)) {
      if (part && part !== trimmed) tokens.push(part);
    }
  };
  pushParts(source.label);
  for (const title of source.titles) pushParts(title);
  for (const platform of source.platforms) pushParts(platform);
  return tokens;
}

function finishTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * One 256×1024 ledger face per tower. Seeded from tower.id so the column
 * layout is stable; titles/platforms only change the injected strings.
 */
export function createDataFaceTexture(source: DataFaceSource): CanvasTexture {
  const canvas = makeCanvas(DATAFACE_WIDTH, DATAFACE_HEIGHT);
  const ctx = canvas.getContext("2d");
  if (!ctx) return finishTexture(canvas);

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, DATAFACE_WIDTH, DATAFACE_HEIGHT);

  const rand = mulberry32(hash32(source.id));
  const tokens = collectLedger(source);
  const cols = 8;
  const colW = DATAFACE_WIDTH / cols;
  const line = 11;

  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (let c = 0; c < cols; c++) {
    const x = colW * (c + 0.5) + (rand() - 0.5) * 3;
    let y = Math.floor(rand() * 36);
    while (y < DATAFACE_HEIGHT) {
      if (rand() < 0.3) {
        y += line * (2 + Math.floor(rand() * 5));
        continue;
      }

      const bright = rand() < 0.14;
      const useLedger = tokens.length > 0 && rand() < 0.42;
      let payload: string;
      if (useLedger) {
        payload = tokens[Math.floor(rand() * tokens.length)] ?? "";
      } else {
        const n = 4 + Math.floor(rand() * 12);
        const alphabet = rand() < 0.65 ? HEX_GLYPHS : ASCII_GLYPHS;
        let s = "";
        for (let i = 0; i < n; i++) s += pickGlyph(rand, alphabet);
        payload = s;
      }

      const intensity = bright ? 0.84 : 0.45;
      ctx.shadowColor = bright ? "rgba(255,255,255,0.4)" : "transparent";
      ctx.shadowBlur = bright ? 3 : 0;
      ctx.fillStyle = `rgba(255,255,255,${intensity})`;

      const chars = payload.toUpperCase();
      for (let i = 0; i < chars.length && y < DATAFACE_HEIGHT; i++) {
        const ch = chars[i] ?? "";
        if (ch === " " || ch === "\t") {
          y += line;
          continue;
        }
        const rowBright = !bright && rand() < 0.07;
        if (rowBright) {
          ctx.fillStyle = "rgba(255,255,255,0.88)";
          ctx.shadowColor = "rgba(255,255,255,0.35)";
          ctx.shadowBlur = 2;
        }
        ctx.fillText(ch, x, y);
        if (rowBright) {
          ctx.fillStyle = `rgba(255,255,255,${intensity})`;
          ctx.shadowBlur = 0;
          ctx.shadowColor = "transparent";
        }
        y += line;
      }
      y += line;
    }
  }

  return finishTexture(canvas);
}
