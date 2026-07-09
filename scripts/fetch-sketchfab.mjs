/**
 * Ingest curated CC-licensed Sketchfab models into the BuildLab local library.
 *
 *   npm run fetch-sketchfab
 *   npm run fetch-sketchfab -- --only=microscope,steam-engine
 *
 * Requires SKETCHFAB_API_TOKEN in .env.local. This is an offline library
 * builder only; live user requests still use Poly Pizza exclusively.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

dotenv.config({ path: ".env.local" });

const execFileAsync = promisify(execFile);

const { computeAutoManifest } = await import("../lib/autoManifest.ts");
const { validateCandidates, MAX_VALIDATION_CANDIDATES } = await import("../lib/assetValidator.ts");
const {
  getSketchfabDownloadArchive,
  hasSketchfabToken,
  searchSketchfabModels,
  sketchfabCredit,
} = await import("../lib/sketchfab.ts");
const { appendCredit, MODELS_DIR, MAX_FILE_BYTES } = await import("../lib/polypizza.ts");

const GENERATED_PATH = path.join(process.cwd(), "lib", "assetManifest.generated.json");
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const ONLY = (() => {
  const flag = args.find((a) => a.startsWith("--only="));
  if (!flag) return null;
  return new Set(flag.slice("--only=".length).split(",").map((s) => slugFor(s.trim())).filter(Boolean));
})();

const CURATED = [
  { name: "Microscope", search: "microscope", aliases: ["lab microscope"], concepts: ["optics", "biology", "magnification"] },
  { name: "Steam Engine", search: "steam engine", aliases: ["locomotive engine"], concepts: ["thermodynamics", "pressure", "mechanical work"] },
  { name: "Turbine Engine", search: "jet turbine engine", aliases: ["jet engine", "turbofan"], concepts: ["thrust", "compression", "turbines"] },
  { name: "Tardigrade", search: "tardigrade", aliases: ["water bear"], concepts: ["microbiology", "adaptation", "survival"] },
  { name: "DNA", search: "dna double helix", aliases: ["double helix"], concepts: ["genetics", "molecules", "biology"] },
  { name: "Lung", search: "human lungs anatomy", aliases: ["lungs"], concepts: ["respiration", "anatomy", "gas exchange"] },
  { name: "Kidney", search: "human kidney anatomy", aliases: ["kidneys"], concepts: ["filtration", "anatomy", "homeostasis"] },
  { name: "Skull", search: "human skull anatomy", aliases: ["cranium"], concepts: ["anatomy", "bones", "protection"] },
  { name: "Camera Lens", search: "camera lens", aliases: ["lens"], concepts: ["optics", "focus", "refraction"] },
  { name: "Game Controller", search: "game controller", aliases: ["controller", "joystick"], concepts: ["input", "electronics", "ergonomics"] },
  { name: "VR Headset", search: "vr headset", aliases: ["virtual reality headset"], concepts: ["stereoscopy", "tracking", "display"] },
  { name: "Drone", search: "quadcopter drone", aliases: ["quadcopter"], concepts: ["rotor lift", "control", "stability"] },
  { name: "Excavator", search: "excavator construction vehicle", aliases: ["digger"], concepts: ["hydraulics", "levers", "construction"] },
  { name: "Crane", search: "construction crane", aliases: ["tower crane"], concepts: ["torque", "counterweight", "structures"] },
  { name: "Water Wheel", search: "water wheel", aliases: ["mill wheel"], concepts: ["energy transfer", "rotation", "hydropower"] },
  { name: "Catapult", search: "catapult", aliases: ["trebuchet"], concepts: ["levers", "projectile motion", "stored energy"] },
  { name: "Compass", search: "compass instrument", aliases: ["magnetic compass"], concepts: ["magnetism", "navigation", "orientation"] },
  { name: "Sextant", search: "sextant", aliases: ["navigation sextant"], concepts: ["navigation", "angles", "astronomy"] },
  { name: "Printing Press", search: "printing press", aliases: ["press"], concepts: ["mechanisms", "history", "communication"] },
  { name: "Bicycle Wheel", search: "bicycle wheel", aliases: ["bike wheel"], concepts: ["spokes", "tension", "rotation"] },
  { name: "Electric Motor", search: "electric motor", aliases: ["motor"], concepts: ["electromagnetism", "rotation", "electricity"] },
  { name: "Generator", search: "electric generator", aliases: ["dynamo"], concepts: ["electromagnetic induction", "energy", "rotation"] },
  { name: "Geodesic Dome", search: "geodesic dome", aliases: ["dome"], concepts: ["triangulation", "structures", "compression"] },
  { name: "Roman Aqueduct", search: "roman aqueduct", aliases: ["aqueduct"], concepts: ["gravity", "civil engineering", "water flow"] },
  { name: "Abacus", search: "abacus", aliases: ["counting frame"], concepts: ["place value", "math", "computation"] },
  { name: "Astrolabe", search: "astrolabe", aliases: ["astronomy instrument"], concepts: ["astronomy", "angles", "navigation"] },
  { name: "Orrery", search: "orrery solar system model", aliases: ["planetary model"], concepts: ["orbits", "gears", "astronomy"] },
  { name: "Fossil", search: "fossil", aliases: ["fossilized bone"], concepts: ["paleontology", "geology", "evolution"] },
  { name: "Neuron", search: "neuron cell", aliases: ["nerve cell"], concepts: ["nervous system", "signals", "biology"] },
  { name: "Solar System", search: "solar system model", aliases: ["planets"], concepts: ["orbits", "gravity", "astronomy"] },
];

function slugFor(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
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

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`archive download failed (${res.status})`);
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

async function chooseMainModel(files) {
  if (files.length === 0) return null;
  const scored = await Promise.all(
    files.map(async (file) => {
      const stat = await fsp.stat(file);
      const name = path.basename(file).toLowerCase();
      let score = stat.size;
      if (name === "scene.gltf" || name === "scene.glb") score += 1_000_000_000;
      if (/\.glb$/i.test(name)) score += 100_000_000;
      return { file, score };
    }),
  );
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.file ?? null;
}

async function copyAsGlb(sourcePath, slug) {
  await fsp.mkdir(MODELS_DIR, { recursive: true });
  const dest = path.join(MODELS_DIR, `${slug}.glb`);
  if (/\.glb$/i.test(sourcePath)) {
    await fsp.copyFile(sourcePath, dest);
  } else {
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.read(sourcePath);
    const glb = await io.writeBinary(doc);
    await fsp.writeFile(dest, Buffer.from(glb));
  }
  return { filePath: dest, publicPath: `/models/${slug}.glb` };
}

function templatedIntro(name) {
  return `Here's a realistic ${name} from Sketchfab's Creative Commons library. Click its parts to inspect it, then ask what to add or how it works — we'll connect the model to real science as we build.`;
}

async function processKeyword(item, manifest) {
  const id = slugFor(item.name);
  const covered = coverageSet(manifest.assets ?? {});
  if (!FORCE && (covered.has(id) || item.aliases.some((alias) => covered.has(slugFor(alias))))) {
    return { keyword: item.name, source: "sketchfab", title: "-", verdict: "skip", note: "existing coverage" };
  }

  const candidates = (await searchSketchfabModels(item.search, MAX_VALIDATION_CANDIDATES))
    .slice(0, MAX_VALIDATION_CANDIDATES);
  if (candidates.length === 0) {
    return { keyword: item.name, source: "sketchfab", title: "-", verdict: "fail", note: "no CC0/CC-BY downloadable candidates" };
  }

  const verdict = await validateCandidates(item.name, candidates.map((m) => m.title));
  if (verdict === 0) {
    return {
      keyword: item.name,
      source: "sketchfab",
      title: candidates.map((m) => m.title).join("; ").slice(0, 80),
      verdict: "skip",
      note: "validator rejected candidates",
    };
  }

  const chosen = candidates[verdict - 1];
  if (!chosen) {
    return { keyword: item.name, source: "sketchfab", title: "-", verdict: "fail", note: "validator returned missing candidate" };
  }

  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), `sketchfab-${id}-`));
  try {
    const archive = await getSketchfabDownloadArchive(chosen.uid);
    const extractDir = path.join(temp, "extract");
    let main;
    if (archive.format === "glb") {
      main = path.join(temp, `${id}.glb`);
      await downloadFile(archive.url, main);
    } else {
      const zipPath = path.join(temp, `${id}.zip`);
      await downloadFile(archive.url, zipPath);
      await unzip(zipPath, extractDir);
      main = await chooseMainModel(await walk(extractDir));
      if (!main) throw new Error("archive contained no GLB/GLTF file");
    }

    const dl = await copyAsGlb(main, id);
    const geo = await computeAutoManifest(dl.filePath);
    const entry = {
      id,
      name: item.name,
      url: dl.publicPath,
      scale: geo.scale,
      yOffset: geo.yOffset,
      boundingBox: geo.boundingBox,
      anchors: geo.anchors,
      aliases: item.aliases,
      concepts: item.concepts,
      intro: templatedIntro(item.name),
      license: chosen.license.label,
      author: chosen.author,
      authorUrl: chosen.authorUrl ?? "",
      attributionUrl: chosen.viewerUrl,
      triCount: chosen.faceCount,
      sourceModelId: chosen.uid,
      source: "prefetch",
      provenance: "sketchfab",
    };
    manifest.assets[id] = entry;
    manifest.generatedAt = new Date().toISOString();
    writeManifest(manifest);
    await appendCredit(sketchfabCredit(chosen, id));
    return {
      keyword: item.name,
      source: "sketchfab",
      title: chosen.title,
      verdict: "added",
      note: `${chosen.license.label} by ${chosen.author}`,
    };
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

function printSummary(rows) {
  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log("\n" + "=".repeat(104));
  console.log(pad("KEYWORD", 22) + pad("SOURCE", 12) + pad("TITLE", 36) + pad("VERDICT", 12) + "NOTE");
  console.log("-".repeat(104));
  for (const row of rows) {
    console.log(
      pad(row.keyword, 22) +
        pad(row.source, 12) +
        pad(row.title ?? "-", 36) +
        pad(row.verdict, 12) +
        (row.note ?? ""),
    );
  }
  console.log("=".repeat(104));
}

async function main() {
  if (!hasSketchfabToken()) {
    console.error(
      "\n✗ SKETCHFAB_API_TOKEN is not set in .env.local.\n" +
        "  Create a free account, copy the token from https://sketchfab.com/settings/password,\n" +
        "  then add: SKETCHFAB_API_TOKEN=your-token-here\n",
    );
    process.exit(1);
  }

  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const manifest = readManifest();
  manifest.assets = manifest.assets ?? {};
  const items = CURATED.filter((item) => !ONLY || ONLY.has(slugFor(item.name)));
  const rows = [];
  console.log(`\nFetching ${items.length} Sketchfab keyword(s)${FORCE ? " (--force)" : ""}...\n`);

  for (const item of items) {
    process.stdout.write(`• ${item.name} ... `);
    try {
      const result = await processKeyword(item, manifest);
      rows.push(result);
      console.log(result.verdict.toUpperCase());
    } catch (err) {
      rows.push({
        keyword: item.name,
        source: "sketchfab",
        title: "-",
        verdict: "fail",
        note: err?.message ?? String(err),
      });
      console.log("FAIL");
    }
  }

  printSummary(rows);
  const added = rows.filter((r) => r.verdict === "added").length;
  const failed = rows.filter((r) => r.verdict === "fail").length;
  const skipped = rows.filter((r) => r.verdict === "skip").length;
  console.log(`\n${added} added, ${failed} failed. Manifest written to ${path.relative(process.cwd(), GENERATED_PATH)}\n`);
  if (failed > 0 && added === 0 && skipped === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nfetch-sketchfab crashed:", err);
  process.exit(1);
});
