/**
 * Generate semantic component names for every asset in the manifest that
 * doesn't already have them (Phase 3.4B, Task 1).
 *
 *   npm run generate-part-names                  # fill in anything missing
 *   npm run generate-part-names -- --force        # regenerate everything
 *   npm run generate-part-names -- --only=rocket,bike
 *
 * For each asset: loads its GLB with @gltf-transform/core (Node-friendly,
 * matches how autoManifest.ts already reads GLBs server-side), extracts
 * per-submesh spatial metadata, and asks the explainer LLM to name each
 * component. If the model has fewer than 3 usable submeshes, also generates
 * virtual hotspot components instead. Results are cached into
 * lib/assetManifest.generated.json under componentMetadata / virtualComponents.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: ".env.local" });

const { extractSubmeshMetadata, getSemanticComponentNames, getVirtualComponents } = await import(
  "../lib/componentNaming.ts"
);

const GENERATED_PATH = path.join(process.cwd(), "lib", "assetManifest.generated.json");
const MODELS_DIR = path.join(process.cwd(), "public", "models");

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const onlyArg = args.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim())) : null;

/** Minimum usable submeshes before we prefer virtual hotspots instead (mirrors CLAUDE.md's "fewer than 3"). */
const MIN_REAL_SUBMESHES = 3;

function readManifest() {
  const raw = fs.readFileSync(GENERATED_PATH, "utf8");
  return JSON.parse(raw);
}

function writeManifest(manifest) {
  fs.writeFileSync(GENERATED_PATH, JSON.stringify(manifest, null, 2));
}

async function processAsset(id, entry) {
  const glbPath = path.join(MODELS_DIR, `${id}.glb`);
  if (!fs.existsSync(glbPath)) {
    console.warn(`  [skip] ${id}: no GLB at ${glbPath}`);
    return null;
  }

  let submeshes;
  try {
    submeshes = await extractSubmeshMetadata(glbPath);
  } catch (err) {
    console.warn(`  [skip] ${id}: failed to read GLB —`, err.message ?? err);
    return null;
  }

  if (submeshes.length >= MIN_REAL_SUBMESHES) {
    const names = await getSemanticComponentNames(entry.name, submeshes);
    const componentMetadata = submeshes.map((m, i) => ({
      rawName: m.name,
      semanticName: names[i] ?? m.name,
    }));
    console.log(`  [ok] ${id}: ${submeshes.length} submeshes ->`, names.join(", "));
    return { componentMetadata, virtualComponents: undefined };
  }

  // Too few real submeshes (0-2) — generate virtual hotspots instead.
  const virtualComponents = await getVirtualComponents(entry.name);
  console.log(
    `  [ok] ${id}: only ${submeshes.length} submeshes -> ${virtualComponents.length} virtual components:`,
    virtualComponents.map((c) => c.name).join(", "),
  );
  return { componentMetadata: undefined, virtualComponents };
}

async function main() {
  const manifest = readManifest();
  const ids = Object.keys(manifest.assets).filter((id) => !ONLY || ONLY.has(id));

  console.log(`Processing ${ids.length} asset(s)${FORCE ? " (--force)" : ""}...\n`);

  const failures = [];
  for (const id of ids) {
    const entry = manifest.assets[id];
    const alreadyDone =
      !FORCE && (entry.componentMetadata?.length > 0 || entry.virtualComponents?.length > 0);
    if (alreadyDone) {
      console.log(`  [cached] ${id}: already has names, skipping`);
      continue;
    }

    console.log(`Processing "${id}" (${entry.name})...`);
    try {
      const result = await processAsset(id, entry);
      if (!result) {
        failures.push(id);
        continue;
      }
      if (result.componentMetadata) {
        manifest.assets[id] = {
          ...entry,
          componentMetadata: result.componentMetadata,
          virtualComponents: undefined,
        };
      } else if (result.virtualComponents) {
        manifest.assets[id] = {
          ...entry,
          componentMetadata: undefined,
          virtualComponents: result.virtualComponents,
        };
      }
      // Write after every asset so partial progress survives a crash/timeout.
      writeManifest(manifest);
    } catch (err) {
      console.error(`  [fail] ${id}:`, err.message ?? err);
      failures.push(id);
    }
  }

  console.log(`\nDone. ${ids.length - failures.length}/${ids.length} succeeded.`);
  if (failures.length > 0) {
    console.log(`Failed: ${failures.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
