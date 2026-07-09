/**
 * Run every offline/library-building asset source in sequence.
 *
 * Poly Pizza remains the only live request-time source. Kenney and Sketchfab
 * are used here only to expand the committed local library.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GENERATED_PATH = path.join(process.cwd(), "lib", "assetManifest.generated.json");

function run(label, args) {
  return new Promise((resolve) => {
    console.log(`\n${"=".repeat(80)}\n${label}\n${"=".repeat(80)}\n`);
    const child = spawn("npm", args, { stdio: "inherit", shell: false });
    child.on("close", (code) => resolve({ label, code: code ?? 1 }));
    child.on("error", (err) => {
      console.error(`${label} failed to start:`, err);
      resolve({ label, code: 1 });
    });
  });
}

function readAssets() {
  try {
    const raw = fs.readFileSync(GENERATED_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Object.values(parsed.assets ?? {});
  } catch {
    return [];
  }
}

function sourceOf(entry) {
  if (entry.provenance) return entry.provenance;
  if (entry.attributionUrl?.includes("poly.pizza")) return "poly_pizza";
  if (entry.attributionUrl?.includes("kenney.nl")) return "kenney";
  if (entry.attributionUrl?.includes("sketchfab.com")) return "sketchfab";
  return entry.source ?? "unknown";
}

function printFinalSummary(results) {
  const assets = readAssets();
  const counts = new Map();
  for (const asset of assets) {
    const source = sourceOf(asset);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log("\n" + "=".repeat(72));
  console.log("FINAL ASSET SOURCE SUMMARY");
  console.log("-".repeat(72));
  console.log(pad("SOURCE", 18) + pad("COUNT", 10) + "STATUS");
  for (const source of ["poly_pizza", "kenney", "sketchfab", "unknown"]) {
    if (!counts.has(source)) continue;
    console.log(pad(source, 18) + pad(counts.get(source), 10) + "manifest rows");
  }
  console.log("-".repeat(72));
  console.log(pad("COMMAND", 28) + pad("EXIT", 8) + "VERDICT");
  for (const result of results) {
    console.log(
      pad(result.label, 28) +
        pad(result.code, 8) +
        (result.code === 0 ? "ok" : "failed"),
    );
  }
  console.log("=".repeat(72));
}

const results = [];
results.push(await run("Poly Pizza fetch-assets", ["run", "fetch-assets"]));
results.push(await run("Kenney fetch-kenney", ["run", "fetch-kenney"]));
results.push(await run("Sketchfab fetch-sketchfab", ["run", "fetch-sketchfab"]));
printFinalSummary(results);

if (results.some((r) => r.code !== 0)) process.exitCode = 1;
