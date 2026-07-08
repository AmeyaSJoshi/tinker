/**
 * Anchor resolution (SERVER-ONLY).
 *
 * When the tutor attaches a part to the base MODEL via `attachTo: { anchor }`,
 * this maps the named anchor to real world coordinates from the asset's
 * auto-anchors. Unknown names are mapped through a small synonym table, and if
 * that still misses we fall back to the model's center and warn — never throw,
 * so a slightly-off anchor name can't crash a build.
 */
import type { AnchorMap, Vec3 } from "./autoManifest";

/** Everyday words the model might use → canonical anchor names. */
const SYNONYMS: Record<string, string> = {
  up: "top",
  summit: "top",
  peak: "top",
  roof: "top",
  head: "top",
  underside: "bottom",
  base: "bottom",
  ground: "bottom",
  foot: "bottom",
  back: "rear",
  behind: "rear",
  tail: "rear",
  forward: "front",
  nose: "front",
  ahead: "front",
  left: "left_side",
  leftside: "left_side",
  right: "right_side",
  rightside: "right_side",
  middle: "center",
  centre: "center",
  core: "center",
};

export interface ResolvedAnchor {
  position: Vec3;
  /** The anchor actually used (may differ from the requested one after fallback). */
  anchor: string;
}

function canonical(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Resolve an anchor name against a model's anchor map. Tries the name directly,
 * then a de-spaced canonical form, then the synonym table, and finally falls
 * back to `center` (with a console.warn) so callers always get a position.
 * Also returns the outward direction of the anchor (useful for part orientation).
 */
export function resolveAnchor(anchors: AnchorMap, name: string): ResolvedAnchor {
  const raw = name ?? "";
  const key = canonical(raw);

  if (anchors[key]) return { position: anchors[key], anchor: key };

  const synonym = SYNONYMS[key.replace(/_/g, "")];
  if (synonym && anchors[synonym]) {
    return { position: anchors[synonym], anchor: synonym };
  }

  console.warn(
    `[anchorResolver] unknown anchor "${raw}" — falling back to "center"`,
  );
  return { position: anchors.center ?? [0, 0, 0], anchor: "center" };
}

/**
 * Get the outward-facing direction vector for an anchor based on which bbox face it's on.
 * Used to auto-orient parts attached to that anchor (e.g., thrusters should point outward).
 */
export function getAnchorDirection(anchor: string): [number, number, number] {
  switch (anchor) {
    case "top":
      return [0, 1, 0];
    case "bottom":
      return [0, -1, 0];
    case "front":
      return [0, 0, 1];
    case "rear":
      return [0, 0, -1];
    case "left_side":
      return [-1, 0, 0];
    case "right_side":
      return [1, 0, 0];
    case "center":
    default:
      return [0, 1, 0]; // default up
  }
}
