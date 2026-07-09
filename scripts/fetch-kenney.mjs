/**
 * Ingest free Kenney CC0 asset packs into the BuildLab local model library.
 *
 *   npm run fetch-kenney
 *   npm run fetch-kenney -- --only=space-kit,nature-kit
 *   npm run fetch-kenney -- --max-per-pack=12
 *
 * Downloads each Kenney ZIP, extracts GLB/GLTF models, converts GLTF to GLB
 * when needed, runs the existing auto-manifest geometry pass, and merges new
 * keyword entries into lib/assetManifest.generated.json. Existing library
 * coverage always wins; this script never overwrites a current Poly Pizza match
 * unless --force is explicitly passed.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const execFileAsync = promisify(execFile);

const { computeAutoManifest } = await import("../lib/autoManifest.ts");
const { KENNEY_PACKS, discoverKenneyDownloadUrl, kenneyCredit } = await import("../lib/kenney.ts");
const { appendCredit, MODELS_DIR, MAX_FILE_BYTES } = await import("../lib/polypizza.ts");

const GENERATED_PATH = path.join(process.cwd(), "lib", "assetManifest.generated.json");
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const ONLY = (() => {
  const flag = args.find((a) => a.startsWith("--only="));
  if (!flag) return null;
  return new Set(flag.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean));
})();
const MAX_PER_PACK = (() => {
  const flag = args.find((a) => a.startsWith("--max-per-pack="));
  if (!flag) return Number.POSITIVE_INFINITY;
  const n = Number(flag.slice("--max-per-pack=".length));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Number.POSITIVE_INFINITY;
})();

const STOP_WORDS = new Set([
  "3d",
  "glb",
  "gltf",
  "model",
  "kenney",
  "default",
  "sample",
  "variant",
  "variation",
  "texture",
  "material",
  "colored",
  "colour",
  "color",
  "small",
  "medium",
  "large",
  "low",
  "high",
]);

const TOO_GENERIC = new Set([
  "tile",
  "tiles",
  "piece",
  "part",
  "edge",
  "corner",
  "straight",
  "curve",
  "base",
  "block",
  "wall",
  "floor",
  "roof",
  "door",
  "window",
  "path",
  "road",
  "line",
  "platform",
]);

function slugFor(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function titleCase(input) {
  return input
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function readManifest() {
  try {
    const raw = fs.readFileSync(GENERATED_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { version: 1, generatedAt: null, assets: {} };
  }
}

function writeManifest(manifest) {
  fs.writeFileSync(GENERATED_PATH, JSON.stringify(manifest, null, 2));
}

function coverageSet(assets) {
  const covered = new Set();
  for (const [id, entry] of Object.entries(assets)) {
    covered.add(slugFor(id));
    covered.add(slugFor(entry.name ?? id));
    for (const alias of entry.aliases ?? []) covered.add(slugFor(alias));
  }
  return covered;
}

function cleanKeyword(filePath) {
  const stem = path.basename(filePath).replace(/\.(glb|gltf)$/i, "");
  const spaced = stem
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\b[a-z]\b/gi, " ");
  const words = spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  while (words.length > 1 && /^[a-z]?\d+$/.test(words.at(-1) ?? "")) words.pop();
  const keyword = words.join("-");
  if (!keyword || TOO_GENERIC.has(keyword)) return null;
  return keyword;
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) ${url}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_FILE_BYTES * 10) {
    throw new Error(`archive is ${(declared / 1024 / 1024).toFixed(1)} MB; skipping`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buffer);
  return buffer.byteLength;
}

async function unzip(zipPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  await execFileAsync("unzip", ["-qq", "-o", zipPath, "-d", destDir]);
}

async function walk(dir) {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "__MACOSX" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(glb|gltf)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function preferModelFile(files) {
  const byKeyword = new Map();
  for (const file of files) {
    const keyword = cleanKeyword(file);
    if (!keyword) continue;
    const current = byKeyword.get(keyword);
    if (!current) {
      byKeyword.set(keyword, file);
      continue;
    }
    const currentIsGlb = /\.glb$/i.test(current);
    const nextIsGlb = /\.glb$/i.test(file);
    if (nextIsGlb && !currentIsGlb) byKeyword.set(keyword, file);
  }
  return byKeyword;
}

async function copyAsGlb(sourcePath, slug) {
  await fsp.mkdir(MODELS_DIR, { recursive: true });
  const dest = path.join(MODELS_DIR, `${slug}.glb`);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(sourcePath);
  const glb = await io.writeBinary(doc);
  await fsp.writeFile(dest, Buffer.from(glb));
  return { filePath: dest, publicPath: `/models/${slug}.glb` };
}

function templatedIntro(name) {
  return `Here's the ${name} model from the expanded free asset library. Click its parts to inspect it, then ask what to add or how it works — we'll connect the model to real science as we build.`;
}

async function processAcceptedModel({ manifest, pack, keyword, sourcePath }) {
  const slug = slugFor(keyword);
  const name = titleCase(keyword);
  const dl = await copyAsGlb(sourcePath, slug);
  const geo = await computeAutoManifest(dl.filePath);
  const entry = {
    id: slug,
    name,
    url: dl.publicPath,
    scale: geo.scale,
    yOffset: geo.yOffset,
    boundingBox: geo.boundingBox,
    anchors: geo.anchors,
    aliases: [keyword],
    concepts: pack.concepts,
    intro: templatedIntro(name),
    license: "CC0 1.0",
    author: "Kenney",
    authorUrl: "https://kenney.nl",
    attributionUrl: pack.pageUrl,
    sourceModelId: `${pack.slug}:${path.basename(sourcePath)}`,
    source: "prefetch",
    provenance: "kenney",
  };
  manifest.assets[slug] = entry;
  manifest.generatedAt = new Date().toISOString();
  await appendCredit(kenneyCredit(pack, slug, name));
  writeManifest(manifest);
  return entry;
}

function printSummary(rows) {
  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log("\n" + "=".repeat(96));
  console.log(pad("KEYWORD", 24) + pad("SOURCE", 12) + pad("TITLE", 28) + pad("VERDICT", 12) + "NOTE");
  console.log("-".repeat(96));
  for (const row of rows) {
    console.log(
      pad(row.keyword, 24) +
        pad("kenney", 12) +
        pad(row.title ?? "-", 28) +
        pad(row.verdict, 12) +
        (row.note ?? ""),
    );
  }
  console.log("=".repeat(96));
}

async function main() {
  const manifest = readManifest();
  manifest.assets = manifest.assets ?? {};
  const rows = [];
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  const packs = KENNEY_PACKS.filter((pack) => !ONLY || ONLY.has(pack.slug));
  console.log(`\nFetching ${packs.length} Kenney pack(s)${FORCE ? " (--force)" : ""}...\n`);

  for (const pack of packs) {
    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), `kenney-${pack.slug}-`));
    try {
      const zipPath = path.join(temp, `${pack.slug}.zip`);
      const extractDir = path.join(temp, "extract");
      const downloadUrl = await discoverKenneyDownloadUrl(pack);
      process.stdout.write(`• ${pack.name} ... `);
      await downloadFile(downloadUrl, zipPath);
      await unzip(zipPath, extractDir);

      const modelFiles = await walk(extractDir);
      const candidates = preferModelFile(modelFiles);
      let accepted = 0;
      let seen = coverageSet(manifest.assets);
      for (const [keyword, sourcePath] of candidates) {
        const slug = slugFor(keyword);
        if (!FORCE && seen.has(slug)) {
          rows.push({ keyword, title: titleCase(keyword), verdict: "skip", note: "existing coverage" });
          continue;
        }
        if (accepted >= MAX_PER_PACK) {
          rows.push({ keyword, title: titleCase(keyword), verdict: "skip", note: "max-per-pack reached" });
          continue;
        }
        try {
          await processAcceptedModel({ manifest, pack, keyword, sourcePath });
          accepted += 1;
          seen = coverageSet(manifest.assets);
          rows.push({ keyword, title: titleCase(keyword), verdict: "added", note: pack.name });
        } catch (err) {
          rows.push({ keyword, title: titleCase(keyword), verdict: "fail", note: err?.message ?? String(err) });
        }
      }
      console.log(`${accepted} added, ${modelFiles.length} model files scanned`);
    } catch (err) {
      console.log("FAIL");
      rows.push({ keyword: pack.slug, title: pack.name, verdict: "fail", note: err?.message ?? String(err) });
    } finally {
      await fsp.rm(temp, { recursive: true, force: true });
    }
  }

  printSummary(rows);
  const added = rows.filter((r) => r.verdict === "added").length;
  const failed = rows.filter((r) => r.verdict === "fail").length;
  console.log(`\n${added} added, ${failed} failed. Manifest written to ${path.relative(process.cwd(), GENERATED_PATH)}\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nfetch-kenney crashed:", err);
  process.exit(1);
});
