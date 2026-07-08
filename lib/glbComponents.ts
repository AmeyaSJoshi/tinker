/**
 * Groups the meshes inside an imported GLB into inspectable "components" —
 * the pieces a learner can hover/click to ask "what is this part?" Real GLBs
 * are wildly inconsistent about naming, so this degrades through three tiers:
 * meaningful mesh names, then shared material names, then (if nothing is
 * usable) a single component covering the whole model. Never throws — a
 * malformed or minimal GLB always yields SOME inspectable surface, or none,
 * but never crashes the scene.
 */
import type { Material, Mesh, Object3D } from "three";

export interface GlbComponent {
  /** Stable grouping key for this load (a mesh or material name, or a sentinel). */
  key: string;
  /** Cleaned, human-readable label shown in tooltips and the parts list. */
  label: string;
  meshes: Mesh[];
}

const JUNK_NAME_RE = /^(mesh|object|node|group|geom|geometry|scene|root|default|model|shape)[_\s-]*\d*$/i;
const PURE_NUMBER_RE = /^\d+$/;

function isJunkName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return true;
  if (PURE_NUMBER_RE.test(trimmed)) return true;
  return JUNK_NAME_RE.test(trimmed);
}

function isMeshObject(obj: Object3D): obj is Mesh {
  return (obj as unknown as { isMesh?: boolean }).isMesh === true;
}

function materialNameOf(mesh: Mesh): string | null {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const name = (mat as Material | undefined)?.name;
  return name && name.trim() !== "" ? name.trim() : null;
}

/** "Wheel_Front_02" -> "Wheel Front"; strips separators/digits, title-cases. */
export function cleanComponentLabel(raw: string): string {
  const spaced = raw.replace(/[_\-.]+/g, " ").replace(/\d+/g, " ").trim();
  const words = spaced.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Part";
  return words
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Group every Mesh under `root` into components:
 *  - meshes with a meaningful `name` are grouped by that name
 *  - meshes with junk/empty names fall back to their material's name
 *  - meshes that still have no usable key are bucketed into "Other Parts"
 *    (as long as at least one real group was found)
 *  - if NOTHING in the whole model has a usable name, the entire model
 *    becomes one component labeled `fallbackLabel`
 * Returns [] if the model has no meshes at all.
 *
 * If `semanticNames` is provided, uses those instead of cleaned raw names
 * (Phase 3.4B LLM-generated names).
 */
export function extractComponents(
  root: Object3D,
  fallbackLabel: string,
  semanticNames?: string[],
): GlbComponent[] {
  const meshes: Mesh[] = [];
  try {
    root.traverse((obj) => {
      if (isMeshObject(obj)) meshes.push(obj);
    });
  } catch (err) {
    console.error("[glbComponents] traverse failed:", err);
    return [];
  }

  if (meshes.length === 0) return [];

  // If semantic names are provided (Phase 3.4B LLM-generated), use them directly.
  // Each semantic name maps 1:1 to a mesh by index.
  if (semanticNames && semanticNames.length === meshes.length) {
    return semanticNames.map((name, index) => ({
      key: `__semantic_${index}__`,
      label: name,
      meshes: [meshes[index]],
    }));
  }

  // Fallback to the original heuristic-based grouping.
  const groups = new Map<string, Mesh[]>();
  const leftover: Mesh[] = [];

  for (const mesh of meshes) {
    const matName = materialNameOf(mesh);
    const key = !isJunkName(mesh.name)
      ? mesh.name
      : !isJunkName(matName)
        ? matName
        : null;

    if (key) {
      const bucket = groups.get(key);
      if (bucket) bucket.push(mesh);
      else groups.set(key, [mesh]);
    } else {
      leftover.push(mesh);
    }
  }

  if (groups.size === 0) {
    return [{ key: "__whole__", label: fallbackLabel, meshes }];
  }

  const components: GlbComponent[] = Array.from(groups.entries()).map(
    ([key, ms]) => ({ key, label: cleanComponentLabel(key), meshes: ms }),
  );

  if (leftover.length > 0) {
    components.push({ key: "__other__", label: "Other Parts", meshes: leftover });
  }

  return disambiguateLabels(components);
}

/**
 * Numbered mesh names ("Cone", "Cone.001", "Cone.002") all clean down to the
 * same label, which would make the Parts list and hover tooltip show several
 * identical, unclickable-looking "Cone" entries. Suffix a running count onto
 * any label shared by more than one component so each stays distinguishable.
 */
function disambiguateLabels(components: GlbComponent[]): GlbComponent[] {
  const counts = new Map<string, number>();
  for (const c of components) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);

  const seen = new Map<string, number>();
  return components.map((c) => {
    const total = counts.get(c.label) ?? 1;
    if (total <= 1) return c;
    const n = (seen.get(c.label) ?? 0) + 1;
    seen.set(c.label, n);
    return { ...c, label: `${c.label} ${n}` };
  });
}
