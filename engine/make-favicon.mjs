// Generate a real multi-resolution favicon.ico (16/32/48px) from the SK Music logo.
// Rendered crisply from the square SVG via sharp, then packed into a standard ICO container
// whose entries embed PNG payloads (valid + supported by every modern browser).
// Exposed as emitFavicon() so the build regenerates dist/favicon.ico from the logo each run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const LOGO = path.join(ROOT, "assets/skmusic_logo.svg");
const SIZES = [16, 32, 48];

// Pack PNG buffers into an ICO. Each ICONDIRENTRY points at a PNG blob; width/height 0 => 256.
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type = icon
  header.writeUInt16LE(images.length, 4);  // image count
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  for (let i = 0; i < images.length; i++) {
    const { size, data } = images[i], e = 16 * i;
    dir.writeUInt8(size >= 256 ? 0 : size, e);       // width
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);   // height
    dir.writeUInt8(0, e + 2);                        // palette colors
    dir.writeUInt8(0, e + 3);                        // reserved
    dir.writeUInt16LE(1, e + 4);                     // color planes
    dir.writeUInt16LE(32, e + 6);                    // bits per pixel
    dir.writeUInt32LE(data.length, e + 8);           // byte size
    dir.writeUInt32LE(offset, e + 12);               // byte offset
    offset += data.length;
  }
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

export async function emitFavicon(destPath, logo = LOGO) {
  const src = fs.readFileSync(logo);
  const images = [];
  for (const size of SIZES) {
    const data = await sharp(src, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    images.push({ size, data });
  }
  fs.writeFileSync(destPath, packIco(images));
  return SIZES;
}

// Direct run: write the committed source copy at assets/favicon.ico.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = path.join(ROOT, "assets/favicon.ico");
  emitFavicon(out).then((s) => console.log(`favicon.ico written (${s.join("/")}px) → ${out}`));
}
