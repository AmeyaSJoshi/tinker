/**
 * Audit the PRELOADED asset library against the same semantic validator used
 * by the live resolve-asset route.
 *
 *   npm run audit-assets
 *
 * For every entry in lib/assetManifest.generated.json, checks the model title
 * it actually downloaded (from public/models/CREDITS.json) against the
 * requested keyword (the entry's display name) using the LLM validator. A bad
 * match (e.g. "Bear" -> "Bear Trap", "Peanut" -> "Peanut Butter", "Bike" ->
 * "Exercise Bike", "Tree" -> "Trees") gets re-searched, re-validated, and
 * replaced in place — same slug, new GLB, new geometry, new credit line.
 *
 * Never fatal: an entry that still can't find a valid replacement is left
 * alone and flagged UNRESOLVED in the printed table.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: ".env.local" });

const {
  downloadGlb,
  appendCredit,
  creditFor,
  hasApiKey,
  OversizeError,
  MODELS_DIR,
  CREDITS_PATH,
} = await import("../lib/polypizza.ts");
const { computeAutoManifest } = await import("../lib/autoManifest.ts");
const { resolveValidatedModel } = await import("../lib/assetResolver.ts");
const { validateCandidates } = await import("../lib/assetValidator.ts");

const GENERATED_PATH = path.join(process.cwd(), "lib", "assetManifest.generated.json");

function readManifest() {
  const raw = fs.readFileSync(GENERATED_PATH, "utf8");
  return JSON.parse(raw);
}

function writeManifest(manifest) {
  fs.writeFileSync(GENERATED_PATH, JSON.stringify(manifest, null, 2));
}

function readCredits() {
  try {
    const raw = fs.readFileSync(CREDITS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Re-search + re-validate + re-download a replacement for a bad entry. */
async function replaceEntry(id, entry) {
  const query = entry.name.toLowerCase();
  const winner = await resolveValidatedModel(entry.name, query, new Set());
  if (!winner) return { status: "unresolved", note: "no validated replacement found" };

  try {
    const dl = await downloadGlb(winner, id);
    const geo = await computeAutoManifest(dl.filePath);
    const nextEntry = {
      ...entry,
      url: dl.publicPath,
      scale: geo.scale,
      yOffset: geo.yOffset,
      boundingBox: geo.boundingBox,
      anchors: geo.anchors,
      license: winner.license,
      author: winner.creator?.name ?? "Unknown",
      authorUrl: winner.creator?.url ?? "",
      attributionUrl: `https://poly.pizza/m/${winner.id}`,
      triCount: winner.triCount,
      sourceModelId: winner.id,
    };
    await appendCredit(creditFor(winner, id));
    return { status: "replaced", note: `"${winner.title}"`, entry: nextEntry };
  } catch (err) {
    if (err instanceof OversizeError) return { status: "unresolved", note: "replacement was oversized" };
    return { status: "unresolved", note: err?.message ?? String(err) };
  }
}

function printTable(rows) {
  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log("\n" + "=".repeat(90));
  console.log(pad("ASSET", 16) + pad("KEYWORD", 14) + pad("ACTUAL TITLE", 22) + pad("VERDICT", 12) + "NOTE");
  console.log("-".repeat(90));
  for (const r of rows) {
    const icon =
      r.verdict === "OK" ? "✅" : r.verdict === "REPLACED" ? "🔁" : r.verdict === "UNRESOLVED" ? "⚠️ " : "❔";
    console.log(
      pad(r.id, 16) + pad(r.keyword, 14) + pad(r.actualTitle, 22) + pad(`${icon} ${r.verdict}`, 12) + (r.note ?? ""),
    );
  }
  console.log("=".repeat(90));
}

async function main() {
  if (!hasApiKey()) {
    console.error("\n✗ POLY_PIZZA_API_KEY is not set in .env.local — cannot audit or replace models.\n");
    process.exit(1);
  }

  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const manifest = readManifest();
  const credits = readCredits();
  const creditByslug = new Map(credits.map((c) => [c.slug, c]));

  const entries = Object.entries(manifest.assets ?? {});
  console.log(`\nAuditing ${entries.length} library assets…\n`);

  const rows = [];
  let changed = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const [id, entry] of entries) {
    const actualTitle = creditByslug.get(id)?.name ?? entry.name;
    process.stdout.write(`• ${entry.name} (${id}) … `);

    // A transient rate-limit on this ONE cheap check shouldn't condemn an
    // already-good entry to a needless re-download, so give it one retry
    // before treating a 0 as a real verdict.
    let verdictIdx = await validateCandidates(entry.name, [actualTitle]);
    if (verdictIdx === 0) {
      await sleep(1500);
      verdictIdx = await validateCandidates(entry.name, [actualTitle]);
    }
    // Pace requests to stay under the provider's rate limit across ~48 entries.
    await sleep(800);
    if (verdictIdx === 1) {
      rows.push({ id, keyword: entry.name, actualTitle, verdict: "OK" });
      console.log("OK");
      continue;
    }

    const result = await replaceEntry(id, entry);
    if (result.status === "replaced") {
      manifest.assets[id] = result.entry;
      changed = true;
      rows.push({ id, keyword: entry.name, actualTitle, verdict: "REPLACED", note: `-> ${result.note}` });
      console.log(`REPLACED -> ${result.note}`);
    } else {
      rows.push({ id, keyword: entry.name, actualTitle, verdict: "UNRESOLVED", note: result.note });
      console.log(`UNRESOLVED (${result.note})`);
    }
  }

  if (changed) {
    manifest.generatedAt = new Date().toISOString();
    writeManifest(manifest);
  }

  printTable(rows);

  const ok = rows.filter((r) => r.verdict === "OK").length;
  const replaced = rows.filter((r) => r.verdict === "REPLACED").length;
  const unresolved = rows.filter((r) => r.verdict === "UNRESOLVED").length;
  console.log(`\n${ok} already good, ${replaced} replaced, ${unresolved} unresolved.\n`);
}

main().catch((err) => {
  console.error("\naudit-assets crashed:", err);
  process.exit(1);
});
