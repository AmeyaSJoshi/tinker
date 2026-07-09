/**
 * Auto-manifest generation (SERVER-ONLY).
 *
 * Given a GLB on disk, load it in Node with @gltf-transform/core, measure its
 * bounding box, and derive everything the app needs to place the model in the
 * scene consistently:
 *   - `scale`   — uniform factor normalizing the model's HEIGHT to ~5 world units
 *   - `yOffset` — vertical shift that rests the model's lowest point on y = 0
 *   - `boundingBox` — the model's extent AFTER scale + yOffset (world space)
 *   - `anchors` — seven heuristic attachment points in that same world space
 *
 * These auto-anchors are the default attachment points for every model, so the
 * tutor can say "put a lamp room on top" and land the part on the real summit
 * of the mesh rather than guessing coordinates.
 */
import { NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

export type Vec3 = [number, number, number];

/** The seven heuristic anchors every auto-processed model gets. */
export interface AnchorMap {
  top: Vec3;
  bottom: Vec3;
  front: Vec3;
  rear: Vec3;
  left_side: Vec3;
  right_side: Vec3;
  center: Vec3;
  [name: string]: Vec3;
}

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

/** The geometric portion of an asset manifest entry, derived purely from the GLB. */
export interface AutoManifestGeometry {
  scale: number;
  yOffset: number;
  boundingBox: BoundingBox;
  anchors: AnchorMap;
}

/** Height every base model is normalized to, in world units. */
export const TARGET_HEIGHT = 5;

/**
 * Read a GLB and compute its normalized placement + anchors.
 *
 * The coordinate math mirrors how <BaseModel> renders the GLB: a uniform
 * `scale` about the model's own origin, then a translation of `[0, yOffset, 0]`.
 * So a source vertex v renders at `scale * v + [0, yOffset, 0]`, and every
 * value here is expressed in that final world space.
 */
export async function computeAutoManifest(
  glbPath: string,
): Promise<AutoManifestGeometry> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(glbPath);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) {
    throw new Error("GLB contains no scene to measure");
  }

  // Raw bounds in the model's own units (world matrices applied by getBounds).
  const { min, max } = getBounds(scene);
  const rawHeight = max[1] - min[1];
  const scale = rawHeight > 1e-6 ? TARGET_HEIGHT / rawHeight : 1;

  // Scale about the origin, then rest the lowest point on the ground plane.
  const sMin: Vec3 = [min[0] * scale, min[1] * scale, min[2] * scale];
  const sMax: Vec3 = [max[0] * scale, max[1] * scale, max[2] * scale];
  const yOffset = -sMin[1];

  // Final world-space box (Y shifted so it starts at 0).
  const wMin: Vec3 = [sMin[0], sMin[1] + yOffset, sMin[2]];
  const wMax: Vec3 = [sMax[0], sMax[1] + yOffset, sMax[2]];
  const size: Vec3 = [wMax[0] - wMin[0], wMax[1] - wMin[1], wMax[2] - wMin[2]];

  const cx = (wMin[0] + wMax[0]) / 2;
  const cy = (wMin[1] + wMax[1]) / 2;
  const cz = (wMin[2] + wMax[2]) / 2;

  const anchors: AnchorMap = {
    // (center-x, max-y, center-z) — the summit.
    top: [cx, wMax[1], cz],
    // (center-x, min-y=0, center-z) — where it meets the ground.
    bottom: [cx, wMin[1], cz],
    // +Z faces the viewer: the front face center.
    front: [cx, cy, wMax[2]],
    // -Z is away from the viewer: the rear face center.
    rear: [cx, cy, wMin[2]],
    left_side: [wMin[0], cy, cz],
    right_side: [wMax[0], cy, cz],
    center: [cx, cy, cz],
  };

  return {
    scale,
    yOffset,
    boundingBox: { min: wMin, max: wMax, size },
    anchors,
  };
}
