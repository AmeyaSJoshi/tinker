/**
 * Prefetch the BuildLab asset library.
 *
 *   npm run fetch-assets            # fill in anything missing
 *   npm run fetch-assets -- --force # redownload everything
 *
 * For each curated keyword it searches Poly Pizza, picks the best model
 * (CC0 > CC-BY, then lowest poly-count), downloads the GLB into public/models/,
 * auto-processes it (scale / yOffset / anchors), generates a teacherly intro via
 * our own LLM, and writes it all into lib/assetManifest.generated.json. Credits
 * land in public/models/CREDITS.json automatically.
 *
 * Run under tsx (see package.json) so it can import the TypeScript lib modules
 * directly. Env comes from .env.local. Idempotent and tolerant: a failed keyword
 * is reported at the end, never fatal.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: ".env.local" });

const {
  searchModels,
  rankModels,
  downloadGlb,
  appendCredit,
  creditFor,
  hasApiKey,
  OversizeError,
  MODELS_DIR,
} = await import("../lib/polypizza.ts");
const { computeAutoManifest } = await import("../lib/autoManifest.ts");
const { generateText } = await import("../lib/llm.ts");

const GENERATED_PATH = path.join(process.cwd(), "lib", "assetManifest.generated.json");
const MAX_CANDIDATES = 6;

/**
 * ~25 education-friendly builds. `search` is the Poly Pizza query; `name` is the
 * display name (and its slug is the id + GLB filename). `aliases` are synonyms
 * used for matching a learner's phrasing; `concepts` are starter learning tags.
 */
const CURATED = [
  { name: "Rocket", search: "rocket", aliases: ["spaceship", "space rocket", "launch vehicle"], concepts: ["thrust", "aerodynamics", "propulsion"] },
  { name: "Space Shuttle", search: "space shuttle", aliases: ["shuttle", "orbiter"], concepts: ["orbit", "re-entry", "spaceflight"] },
  { name: "Satellite", search: "satellite", aliases: ["space satellite", "orbiter probe"], concepts: ["orbit", "communications", "solar power"] },
  { name: "Volcano", search: "volcano", aliases: ["volcanic mountain", "eruption"], concepts: ["magma", "plate tectonics", "eruption"] },
  { name: "Human Heart", search: "heart organ", aliases: ["heart", "anatomical heart"], concepts: ["circulation", "anatomy", "pumping"] },
  { name: "Brain", search: "brain", aliases: ["human brain", "cerebrum"], concepts: ["neurons", "anatomy", "cognition"] },
  { name: "Skeleton", search: "skeleton", aliases: ["human skeleton", "bones"], concepts: ["anatomy", "bones", "structure"] },
  { name: "Airplane", search: "airplane", aliases: ["plane", "aeroplane", "jet"], concepts: ["lift", "aerodynamics", "flight"] },
  { name: "Helicopter", search: "helicopter", aliases: ["chopper", "rotorcraft"], concepts: ["rotor lift", "torque", "flight"] },
  { name: "Submarine", search: "submarine", aliases: ["sub", "u-boat"], concepts: ["buoyancy", "pressure", "ballast"] },
  { name: "Sailboat", search: "sailboat", aliases: ["sailing boat", "yacht", "boat"], concepts: ["buoyancy", "wind power", "sailing"] },
  { name: "Race Car", search: "race car", aliases: ["racecar", "formula car", "sports car"], concepts: ["aerodynamics", "downforce", "friction"] },
  { name: "Train", search: "train", aliases: ["locomotive", "railway train"], concepts: ["rails", "momentum", "friction"] },
  { name: "Bridge", search: "bridge", aliases: ["suspension bridge", "overpass"], concepts: ["tension", "compression", "load bearing"] },
  { name: "Castle", search: "castle", aliases: ["fortress", "fort"], concepts: ["fortification", "architecture", "defense"] },
  { name: "Windmill", search: "windmill", aliases: ["wind mill", "mill"], concepts: ["wind power", "gears", "mechanical work"] },
  { name: "Wind Turbine", search: "wind turbine", aliases: ["turbine", "wind generator"], concepts: ["wind energy", "aerodynamics", "electricity"] },
  { name: "Solar Panel", search: "solar panel", aliases: ["solar array", "photovoltaic panel"], concepts: ["photovoltaics", "solar energy", "electricity"] },
  { name: "Robot", search: "robot", aliases: ["android", "mech"], concepts: ["actuators", "sensors", "control"] },
  { name: "T-Rex", search: "t-rex", aliases: ["trex", "tyrannosaurus", "dinosaur"], concepts: ["paleontology", "predators", "evolution"] },
  { name: "Shark", search: "shark", aliases: ["great white shark"], concepts: ["buoyancy", "predators", "marine biology"] },
  { name: "Whale", search: "whale", aliases: ["blue whale", "humpback whale"], concepts: ["marine mammals", "buoyancy", "filter feeding"] },
  { name: "Tree", search: "tree", aliases: ["oak tree", "plant"], concepts: ["photosynthesis", "ecosystems", "growth"] },
  { name: "House", search: "house", aliases: ["home", "cottage"], concepts: ["architecture", "structure", "insulation"] },
  { name: "Telescope", search: "telescope", aliases: ["observatory telescope"], concepts: ["optics", "lenses", "astronomy"] },
  { name: "Lighthouse", search: "lighthouse", aliases: ["light house", "beacon tower"], concepts: ["optics", "navigation", "refraction"] },
];

const args = process.argv.slice(2);
const FORCE = args.includes("--force");

/**
 * `--only=lighthouse,shark` restricts the run to the named keywords (matched
 * against each item's slug id) and force-refreshes just those, leaving every
 * other cached asset untouched. Handy for fixing a few bad matches without
 * re-downloading the whole library.
 */
const ONLY = (() => {
  const flag = args.find((a) => a.startsWith("--only="));
  if (!flag) return null;
  const set = new Set(
    flag
      .slice("--only=".length)
      .split(",")
      .map((s) => slugFor(s.trim()))
      .filter(Boolean),
  );
  return set.size > 0 ? set : null;
})();

function readExistingAssets() {
  try {
    const raw = fs.readFileSync(GENERATED_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.assets ?? {};
  } catch {
    return {};
  }
}

function slugFor(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Below this triangle count a mesh is too degenerate to be a recognizable model
 * (e.g. a 4-triangle "Paper airplane"). A reported count of 0 means "unknown",
 * not "empty", so we keep those.
 */
const MIN_TRIS = 20;

/**
 * Relevance tokens = words (3+ chars) of the DISPLAY NAME only — the thing we
 * actually want (e.g. "Lighthouse" -> ["lighthouse"]). We deliberately do NOT
 * use the search phrase (its disambiguators like "passenger" cause false hits)
 * nor the model's tags (junk models are tagged with the keyword, e.g. a "Bone"
 * tagged "skeleton").
 */
function nameTokens(item) {
  return item.name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

/** True when a model's TITLE (not tags) contains any of the name tokens. */
function titleMatchesKeyword(model, tokens) {
  const title = (model.title ?? "").toLowerCase();
  return tokens.some((tok) => title.includes(tok));
}

/** A recognizable mesh: unknown tri-count (0) or at least MIN_TRIS triangles. */
function notDegenerate(model) {
  const tris = model.triCount;
  return tris == null || tris === 0 || tris >= MIN_TRIS;
}

/**
 * Re-order ranked candidates so ones whose TITLE actually names the model come
 * first (license/poly-count order preserved within each group), after dropping
 * degenerate meshes. This is what stops a low-poly CC0 "Roof Radar" from winning
 * a "lighthouse" search or a 4-tri paper plane from winning "airplane".
 */
function preferRelevant(ranked, item) {
  const tokens = nameTokens(item);
  // Prefer real geometry, but never let the floor empty the pool entirely.
  const usable = ranked.filter(notDegenerate);
  const pool = usable.length > 0 ? usable : ranked;
  const relevant = pool.filter((m) => titleMatchesKeyword(m, tokens));
  const rest = pool.filter((m) => !titleMatchesKeyword(m, tokens));
  return [...relevant, ...rest];
}

/** Ask our LLM for a ~60-word teacherly intro; fall back to a template on failure. */
async function generateIntro(name) {
  const prompt = `Write a single paragraph of about 60 words introducing a ${name} to a curious learner who is about to build and explore a 3D model of it. Be warm and concrete, spark curiosity, and hint at the science or engineering worth exploring. Plain prose only — no lists, no headings, no markdown.`;
  try {
    const text = await generateText(prompt);
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length > 20) return clean;
  } catch (err) {
    console.warn(`  ! intro generation failed for ${name}: ${err?.message ?? err}`);
  }
  return `Let's explore a ${name}. Click any part to learn what it does, then tell me what to add — we'll uncover the science together as we build it up.`;
}

async function processItem(item, existing) {
  const id = slugFor(item.name);
  const filePath = path.join(MODELS_DIR, `${id}.glb`);
  const alreadyDownloaded = fs.existsSync(filePath);
  // --only always refreshes the named items; otherwise honor --force / cache.
  const forceItem = FORCE || (ONLY !== null && ONLY.has(id));

  if (!forceItem && alreadyDownloaded && existing[id]) {
    return { id, name: item.name, status: "skip", note: "cached", entry: existing[id] };
  }

  const results = await searchModels(item.search, 24);
  if (results.length === 0) {
    return { id, name: item.name, status: "fail", note: "no results" };
  }

  // Rank by license/poly-count, then float keyword-relevant titles to the top.
  const ranked = preferRelevant(rankModels(results), item).slice(0, MAX_CANDIDATES);
  let chosen = null;
  let download = null;
  for (const model of ranked) {
    try {
      download = await downloadGlb(model, id);
      chosen = model;
      break;
    } catch (err) {
      if (err instanceof OversizeError) continue;
      console.warn(`  ! candidate failed for ${item.name}: ${err?.message ?? err}`);
    }
  }
  if (!chosen || !download) {
    return { id, name: item.name, status: "fail", note: "all candidates failed/oversized" };
  }

  const geo = await computeAutoManifest(download.filePath);
  const intro = await generateIntro(item.name);

  const entry = {
    id,
    name: item.name,
    url: download.publicPath,
    scale: geo.scale,
    yOffset: geo.yOffset,
    boundingBox: geo.boundingBox,
    anchors: geo.anchors,
    aliases: item.aliases,
    concepts: item.concepts,
    intro,
    license: chosen.license,
    author: chosen.creator?.name ?? "Unknown",
    authorUrl: chosen.creator?.url ?? "",
    attributionUrl: `https://poly.pizza/m/${chosen.id}`,
    triCount: chosen.triCount,
    source: "prefetch",
    provenance: "poly_pizza",
  };

  await appendCredit(creditFor(chosen, id));

  return {
    id,
    name: item.name,
    status: "ok",
    note: `“${chosen.title}” — ${(download.bytes / 1024 / 1024).toFixed(1)} MB`,
    title: chosen.title,
    tris: chosen.triCount,
    license: chosen.license,
    entry,
  };
}

function printSummary(rows) {
  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log("\n" + "=".repeat(64));
  console.log(pad("ASSET", 18) + pad("STATUS", 9) + pad("TRIS", 9) + pad("LICENSE", 10) + "NOTE");
  console.log("-".repeat(64));
  for (const r of rows) {
    const icon = r.status === "ok" ? "✅" : r.status === "skip" ? "⏭️ " : "❌";
    console.log(
      pad(r.name, 18) +
        pad(`${icon} ${r.status}`, 9) +
        pad(r.tris ?? "-", 9) +
        pad(r.license ?? "-", 10) +
        (r.note ?? ""),
    );
  }
  console.log("=".repeat(64));
}

async function main() {
  if (!hasApiKey()) {
    console.error(
      "\n✗ POLY_PIZZA_API_KEY is not set in .env.local.\n" +
        "  Get a free key at https://poly.pizza/settings/api and add:\n" +
        "  POLY_PIZZA_API_KEY=your-key-here\n",
    );
    process.exit(1);
  }

  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const existing = readExistingAssets();
  const assets = { ...existing };
  const rows = [];

  console.log(`\nFetching ${CURATED.length} assets${FORCE ? " (--force)" : ""}…\n`);

  for (const item of CURATED) {
    const id = slugFor(item.name);
    // With --only, leave every other asset exactly as it is on disk.
    if (ONLY !== null && !ONLY.has(id)) {
      const entry = existing[id];
      if (entry) assets[id] = entry;
      rows.push({ id, name: item.name, status: "skip", note: "unchanged (--only)", entry });
      continue;
    }
    process.stdout.write(`• ${item.name} … `);
    try {
      const result = await processItem(item, existing);
      if (result.entry) assets[result.id] = result.entry;
      rows.push(result);
      console.log(result.status.toUpperCase());
    } catch (err) {
      rows.push({ id: slugFor(item.name), name: item.name, status: "fail", note: err?.message ?? String(err) });
      console.log("FAIL");
    }
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    assets,
  };
  fs.writeFileSync(GENERATED_PATH, JSON.stringify(manifest, null, 2));

  printSummary(rows);

  const failed = rows.filter((r) => r.status === "fail");
  const ok = rows.filter((r) => r.status === "ok").length;
  const skipped = rows.filter((r) => r.status === "skip").length;
  console.log(`\n${ok} downloaded, ${skipped} cached, ${failed.length} failed.`);
  if (failed.length > 0) {
    console.log("\nFailed keywords (pick replacement search terms):");
    for (const f of failed) console.log(`  - ${f.name}: ${f.note}`);
  }
  console.log(`\nManifest written to ${path.relative(process.cwd(), GENERATED_PATH)}\n`);
}

main().catch((err) => {
  console.error("\nfetch-assets crashed:", err);
  process.exit(1);
});
