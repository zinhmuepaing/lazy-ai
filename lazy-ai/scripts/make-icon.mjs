// Lizzie — Windows icon builder (Phase 3 packaging).
//
// electron-builder needs a square multi-size .ico for the NSIS installer and the
// app/window icon. Our brand logo (assets/Lizzie_Logo.png) is non-square, and
// sharp can't write .ico directly, so we:
//   1. pad the logo to a square (transparent letterbox — no distortion), and
//   2. emit it at the standard icon sizes as PNG buffers, then
//   3. assemble them into a single .ico container (PNG-encoded entries, valid on
//      Windows Vista+ and accepted by electron-builder).
//
// Run:  npm run make:icon   (auto-run by `npm run dist`)

import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "..", "assets", "Lizzie_Logo.png");
const OUT = resolve(__dirname, "..", "assets", "icon.ico");

// Windows icon sizes. 256 is required by electron-builder; the rest keep the
// icon crisp at every shell scale (taskbar, alt-tab, Explorer, tray).
const SIZES = [256, 128, 64, 48, 32, 16];

async function pngAt(size) {
  return sharp(await readFile(SRC))
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count; // image data starts after header + directory
  images.forEach(({ size, data }, i) => {
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e + 0); // width  (0 means 256)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1); // height (0 means 256)
    dir.writeUInt8(0, e + 2); // palette colors (0 for true-color)
    dir.writeUInt8(0, e + 3); // reserved
    dir.writeUInt16LE(1, e + 4); // color planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(data.length, e + 8); // bytes of image data
    dir.writeUInt32LE(offset, e + 12); // offset to image data
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...images.map((img) => img.data)]);
}

async function main() {
  const images = [];
  for (const size of SIZES) images.push({ size, data: await pngAt(size) });
  const ico = buildIco(images);
  await writeFile(OUT, ico);
  console.log(`Wrote ${OUT} (${SIZES.join(", ")} px, ${(ico.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(`[make:icon] ${err.message}`);
  process.exit(1);
});
