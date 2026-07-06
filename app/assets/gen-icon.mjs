// Dependency-free icon generator for the WhatsApp Bridge tray app.
// Renders two PNGs with a tiny software rasterizer (4x4 supersampling):
//   assets/icon-1024.png  — colored app icon (rounded square + chat bubble)
//   src-tauri/icons/tray.png — 44x44 monochrome glyph (macOS template image)
// Run: node assets/gen-icon.mjs   (from app/)
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ── minimal PNG writer ─────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function writePng(path, w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

// ── shapes (point-in tests, normalized to a 1024 design grid) ──────
const roundedRect = (x, y, w, h, r) => (px, py) => {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  // distance from the nearest corner-arc center; zero when in the straight zones
  const dx = Math.max(x + r - px, px - (x + w - r), 0);
  const dy = Math.max(y + r - py, py - (y + h - r), 0);
  return dx * dx + dy * dy <= r * r;
};
const circle = (cx, cy, r) => (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
const triangle = (a, b, c) => (px, py) => {
  const s = (p, q) => (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const union = (...fns) => (px, py) => fns.some((f) => f(px, py));

function coverage(shape, px, py, scale) {
  // 4x4 supersample; px/py in output pixels, shape in 1024 design units.
  let hit = 0;
  for (let sy = 0; sy < 4; sy++)
    for (let sx = 0; sx < 4; sx++)
      if (shape(((px + (sx + 0.5) / 4) / scale) * 1024, ((py + (sy + 0.5) / 4) / scale) * 1024)) hit++;
  return hit / 16;
}

function render(size, layers) {
  // layers: { shape, color:[r,g,b,a] | "erase" }
  const buf = Buffer.alloc(size * size * 4);
  for (const layer of layers) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cov = coverage(layer.shape, x, y, size);
        if (cov === 0) continue;
        const i = (y * size + x) * 4;
        if (layer.color === "erase") {
          buf[i + 3] = Math.round(buf[i + 3] * (1 - cov));
          continue;
        }
        const [r, g, b, a] = layer.color;
        const sa = (a / 255) * cov;
        const da = buf[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        if (oa === 0) continue;
        buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
        buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
        buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
        buf[i + 3] = Math.round(oa * 255);
      }
    }
  }
  return buf;
}

// Chat-bubble glyph (1024 design grid): rounded bubble + tail + three dots.
const bubble = union(
  roundedRect(232, 292, 560, 356, 100),
  triangle([332, 610], [300, 764], [472, 648]),
);
const dots = [circle(392, 470, 40), circle(512, 470, 40), circle(632, 470, 40)];

// App icon: green rounded square, white bubble, green dots.
const GREEN = [32, 168, 92, 255];
const appIcon = render(1024, [
  { shape: roundedRect(60, 60, 904, 904, 212), color: GREEN },
  { shape: bubble, color: [255, 255, 255, 255] },
  ...dots.map((d) => ({ shape: d, color: GREEN })),
]);
writePng(join(here, "icon-1024.png"), 1024, 1024, appIcon);

// Tray icon: black glyph on transparency, dots punched out (macOS template).
const tray = render(44, [
  { shape: bubble, color: [0, 0, 0, 255] },
  ...dots.map((d) => ({ shape: d, color: "erase" })),
]);
mkdirSync(join(here, "..", "src-tauri", "icons"), { recursive: true });
writePng(join(here, "..", "src-tauri", "icons", "tray.png"), 44, 44, tray);

console.log("wrote icon-1024.png and src-tauri/icons/tray.png");
