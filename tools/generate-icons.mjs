// Generates the extension icons as real PNG files, with no dependencies
// beyond Node's built-in zlib. Run automatically by `npm run build`.
//
// The mark is a shield with a check: protection that says "approved", which
// reads better than an emoji at 16px.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ── PNG encoding ────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type: RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  // Raw scanlines with filter byte 0 (None) in front of every row.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── The mark ────────────────────────────────────────────────────────────────
const TOP = [99, 102, 241]; // #6366f1 — matches --primary in style.css
const BOTTOM = [59, 130, 246]; // #3b82f6
const RIM = [255, 255, 255];

function shieldHalfWidth(ny) {
  const top = 0.045;
  const cornerR = 0.17;
  const maxHalf = 0.41;
  const bottom = 0.955;
  const taperStart = 0.56;

  if (ny < top || ny > bottom) return -1;

  if (ny < top + cornerR) {
    const dy = top + cornerR - ny;
    const inner = cornerR * cornerR - dy * dy;
    if (inner <= 0) return -1;
    return maxHalf - cornerR + Math.sqrt(inner);
  }

  if (ny <= taperStart) return maxHalf;

  const t = (ny - taperStart) / (bottom - taperStart);
  return maxHalf * Math.max(0, 1 - Math.pow(t, 1.7));
}

function shieldCoverage(nx, ny) {
  const half = shieldHalfWidth(ny);
  if (half < 0) return 0;
  return Math.abs(nx - 0.5) <= half ? 1 : 0;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.hypot(dx, dy);
}

function checkCoverage(nx, ny) {
  const thickness = 0.055;
  const a = segmentDistance(nx, ny, 0.31, 0.53, 0.45, 0.67);
  const b = segmentDistance(nx, ny, 0.45, 0.67, 0.72, 0.34);
  return Math.min(a, b) <= thickness ? 1 : 0;
}

const SAMPLES = 3;
const SAMPLE_STEP = 1 / SAMPLES;

export function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let shield = 0;
      let check = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const nx = (x + (sx + 0.5) * SAMPLE_STEP) / size;
          const ny = (y + (sy + 0.5) * SAMPLE_STEP) / size;
          const s = shieldCoverage(nx, ny);
          shield += s;
          if (s) check += checkCoverage(nx, ny);
        }
      }

      const total = SAMPLES * SAMPLES;
      shield /= total;
      check /= total;

      const index = (y * size + x) * 4;
      if (shield <= 0) {
        rgba[index] = 0;
        rgba[index + 1] = 0;
        rgba[index + 2] = 0;
        rgba[index + 3] = 0;
        continue;
      }

      const ny = (y + 0.5) / size;
      const nx = (x + 0.5) / size;
      let r = TOP[0] + (BOTTOM[0] - TOP[0]) * ny;
      let g = TOP[1] + (BOTTOM[1] - TOP[1]) * ny;
      let b = TOP[2] + (BOTTOM[2] - TOP[2]) * ny;

      // Thin inner rim so the silhouette stays crisp on dark backgrounds.
      const half = shieldHalfWidth(ny);
      const onEdge = half >= 0 && Math.abs(nx - 0.5) > half - 0.035;
      if (onEdge) {
        r = r * 0.45 + RIM[0] * 0.55;
        g = g * 0.45 + RIM[1] * 0.55;
        b = b * 0.45 + RIM[2] * 0.55;
      }

      if (check > 0) {
        r = r + (255 - r) * check;
        g = g + (255 - g) * check;
        b = b + (255 - b) * check;
      }

      rgba[index] = Math.round(Math.max(0, Math.min(255, r)));
      rgba[index + 1] = Math.round(Math.max(0, Math.min(255, g)));
      rgba[index + 2] = Math.round(Math.max(0, Math.min(255, b)));
      rgba[index + 3] = Math.round(shield * 255);
    }
  }

  return encodePng(size, size, rgba);
}

export function generateIcons(outDir, sizes = [16, 32, 48, 128]) {
  mkdirSync(outDir, { recursive: true });
  for (const size of sizes) {
    writeFileSync(`${outDir}/icon${size}.png`, renderIcon(size));
  }
  return sizes.map((size) => `${outDir}/icon${size}.png`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const out = process.argv[2] || "src/icons";
  console.log("✔ Icons written:", generateIcons(out).join(", "));
}
