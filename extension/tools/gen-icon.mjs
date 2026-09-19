/**
 * Generates a 128x128 PNG app icon with no external deps: a Netflix-red rounded
 * tile with a white "W". Run: node tools/gen-icon.mjs
 * Then downscale with sips (see package.json "icons" script).
 */
import { deflateSync } from "zlib";
import { writeFileSync, mkdirSync } from "fs";

const S = 128;
const px = Buffer.alloc(S * S * 4);

const RED = [229, 9, 20];
const WHITE = [255, 255, 255];
const radius = 24;

function set(x, y, [r, g, b], a = 255) {
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

// Rounded-rect background test.
function insideRounded(x, y) {
  const rx = Math.min(x, S - 1 - x);
  const ry = Math.min(y, S - 1 - y);
  if (rx >= radius || ry >= radius) return true;
  const dx = radius - rx;
  const dy = radius - ry;
  return dx * dx + dy * dy <= radius * radius;
}

// White "W" drawn as four thick strokes.
const W_POINTS = [
  [32, 40], // top-left
  [52, 90], // bottom-left valley
  [64, 58], // middle peak
  [76, 90], // bottom-right valley
  [96, 40], // top-right
];
const STROKE = 8; // half-width of the strokes

function distToSegment(px_, py_, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px_ - ax) * dx + (py_ - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px_ - cx, py_ - cy);
}

function insideW(x, y) {
  for (let i = 0; i < W_POINTS.length - 1; i++) {
    if (distToSegment(x, y, W_POINTS[i], W_POINTS[i + 1]) <= STROKE) return true;
  }
  return false;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!insideRounded(x, y)) {
      set(x, y, [0, 0, 0], 0); // transparent corners
    } else if (insideW(x, y)) {
      set(x, y, WHITE);
    } else {
      set(x, y, RED);
    }
  }
}

// Encode PNG (RGBA, 8-bit).
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// rest zero (compression, filter, interlace)

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter type 0
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = deflateSync(raw);

const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("icons", { recursive: true });
writeFileSync("icons/icon128.png", png);
console.log("wrote icons/icon128.png");
