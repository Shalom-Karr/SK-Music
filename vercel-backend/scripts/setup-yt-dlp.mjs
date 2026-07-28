import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function assetName() {
  const { platform, arch } = process;
  if (platform === "linux") {
    if (arch === "x64") return "yt-dlp_linux";
    if (arch === "arm64" || arch === "aarch64") return "yt-dlp_linux_aarch64";
    if (arch === "armv7l") return "yt-dlp_linux_armv7l";
  }
  if (platform === "darwin") {
    return "yt-dlp_macos";
  }
  if (platform === "win32") {
    if (arch === "x64") return "yt-dlp.exe";
    if (arch === "arm64") return "yt-dlp_arm64.exe";
    if (arch === "ia32") return "yt-dlp_x86.exe";
  }
  if (platform === "android" && arch === "arm64") {
    return "yt-dlp_linux_aarch64";
  }
  return null;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(new URL(res.headers.location, url).toString(), dest)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: ${res.statusCode} ${res.statusMessage}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
      file.on("error", reject);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error("Download timed out"));
    });
  });
}

async function main() {
  const asset = assetName();
  if (!asset) {
    console.log(`[setup-yt-dlp] No standalone yt-dlp binary for ${process.platform} ${process.arch}; leaving package default.`);
    process.exit(0);
  }

  const mainPath = require.resolve("ytdlp-nodejs");
  const binDir = path.resolve(path.dirname(mainPath), "..", "bin");
  const target = path.join(binDir, "yt-dlp");

  fs.mkdirSync(binDir, { recursive: true });

  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  console.log(`[setup-yt-dlp] Downloading standalone yt-dlp binary for ${process.platform} ${process.arch} from ${url}`);

  await download(url, `${target}.tmp`);
  fs.renameSync(`${target}.tmp`, target);

  if (process.platform !== "win32") {
    fs.chmodSync(target, 0o755);
  }

  console.log(`[setup-yt-dlp] Standalone yt-dlp installed at ${target}`);
}

main().catch((err) => {
  console.error("[setup-yt-dlp] Failed to install standalone yt-dlp:", err.message);
  // Do not fail the whole install; the package's own binary may still work in some environments.
  process.exit(0);
});
