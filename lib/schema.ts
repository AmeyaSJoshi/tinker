import { z } from "zod";

/**
 * THE PARTS MANIFEST — single source of truth for all 3D content.
 *
 * Gemini must ONLY return JSON matching `tutorResponseSchema`. Everything the
 * viewport renders is derived from these types, so this file is the contract
 * between the LLM, the scene store, and the React components.
 */

export const shapeSchema = z.enum([
  "box",
  "sphere",
  "cylinder",
  "cone",
  "torus",
  "capsule",
]);
export type Shape = z.infer<typeof shapeSchema>;

/**
 * Only include the dimension keys relevant to a given shape. All are optional
 * so a part can carry exactly the fields its primitive needs.
 */
export const dimensionsSchema = z.object({
  width: z.number().optional(),
  height: z.number().optional(),
  depth: z.number().optional(),
  radius: z.number().optional(),
  radiusTop: z.number().optional(),
  radiusBottom: z.number().optional(),
});
export type Dimensions = z.infer<typeof dimensionsSchema>;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof vec3>;

/**
 * Optional attachment. When a part attaches to a GLB base MODEL, the tutor may
 * name one of the model's auto-anchors instead of guessing coordinates. When a
 * detail attaches to another primitive part, the tutor may name that part id.
 * The server resolves either form into a touching world-space position before
 * the part is rendered. Absent = use `position` verbatim.
 */
export const attachToSchema = z.union([
  z.object({
    anchor: z.string().min(1),
    offset: vec3.optional(),
    /**
     * Which entry of a compound scene's `baseAssets` array this attaches to
     * (0-indexed; default 0 = the single/primary base). Schema-only for now —
     * deeper multi-asset attachment resolution is a later phase.
     */
    assetIndex: z.number().int().nonnegative().optional(),
  }),
  z.object({
    partId: z.string().min(1),
    offset: vec3.optional(),
  }),
]);
export type AttachTo = z.infer<typeof attachToSchema>;

export const partSchema = z.object({
  id: z.string().min(1),
  shape: shapeSchema,
  dimensions: dimensionsSchema,
  position: vec3,
  rotation: vec3,
  color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
    message: "color must be a hex string like #aabbcc",
  }),
  name: z.string().min(1),
  explanation: z.string().min(1),
  concepts: z.array(z.string()),
  attachTo: attachToSchema.optional(),
  /**
   * Optional group name. Parts with the same group string form a logical component
   * (e.g., thruster = bell + nozzle + collar). Treated as a single item in the
   * parts list and explanations. Helps the tutor compose multi-part systems.
   */
  group: z.string().optional(),
});
export type Part = z.infer<typeof partSchema>;

export const actionSchema = z.enum([
  "create_base",
  "add_parts",
  "modify_parts",
  "explain",
]);
export type Action = z.infer<typeof actionSchema>;

const hexColor = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
  message: "color must be a hex string like #aabbcc",
});

/**
 * Deterministic, client-executed scene commands ("make it smaller", "change
 * the color", "reset view"). These never depend on the LLM getting world
 * coordinates right — each op is applied by fixed client logic after the
 * reply arrives, so a vague request always produces a correct, visible effect.
 */
export const sceneOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("scale_base"), factor: z.number().positive() }),
  z.object({ op: z.literal("recolor_base"), color: hexColor }),
  z.object({
    op: z.literal("recolor_part"),
    partId: z.string().min(1),
    color: hexColor,
  }),
  z.object({ op: z.literal("brighten_base") }),
  z.object({ op: z.literal("reset_camera") }),
  z.object({ op: z.literal("frame_all") }),
]);
export type SceneOp = z.infer<typeof sceneOpSchema>;

/**
 * A single chat turn. `role` mirrors the sender; `content` is the human-readable
 * text (the tutor's `reply`, never raw JSON). Sent to the API so Gemini — which
 * is stateless — has the full conversation on every request. "note" is a quiet,
 * client-only aside (e.g. "Stopped.") — it's never sent as conversation history.
 */
export interface ChatMessage {
  role: "user" | "tutor" | "note";
  content: string;
}

/**
 * Client-safe description of a loaded base MODEL (a realistic GLB). This is the
 * subset of an asset-library entry the browser needs to render + frame + explain
 * the model. Anchors and attribution metadata stay server-side.
 */
export interface BaseAsset {
  id: string;
  name: string;
  /** Web path to the GLB, e.g. "/models/volcano.glb". */
  url: string;
  scale: number;
  yOffset: number;
  intro: string;
  concepts: string[];
  /** World-space extent (after scale + yOffset) — used to auto-frame the camera. */
  boundingBox: { min: Vec3; max: Vec3; size: Vec3 };
  /** Poly Pizza's own model id, tracked so a rejected model is never re-picked. */
  sourceModelId?: string;
  /** LLM-generated semantic names for submeshes (Phase 3.4B). */
  componentMetadata?: Array<{ rawName: string; semanticName: string }>;
  /** Virtual components for single-mesh models (Phase 3.4B). */
  virtualComponents?: Array<{
    name: string;
    position: Vec3; // normalized -1..1
    whatItIs: string;
  }>;
}

/**
 * One GLB base model placed within a COMPOUND scene ("gaming setup" -> desk,
 * monitor, chair, ...). `position` is the world-space offset for this
 * component within the composed arrangement (added on top of the asset's own
 * baked-in yOffset); `scale` is an extra footprint-relative multiplier on top
 * of the asset's own baked-in scale. Single-asset builds don't use this —
 * they keep using the plain `baseAsset` field untouched.
 */
export interface PlacedAsset {
  asset: BaseAsset;
  position: Vec3;
  scale?: number;
}

export const tutorResponseSchema = z.object({
  /**
   * The model's spatial plan, emitted FIRST so it has to think before it emits
   * coordinates: current-scene bounding box, the anchor part it attaches to,
   * the attachment point, and the size ratio it chose. Never rendered in the
   * UI — it exists purely to force planning and to aid debugging drift.
   */
  reasoning: z.string(),
  action: actionSchema,
  reply: z.string(),
  /**
   * When `action` is "create_base" and the build resolves to a realistic GLB
   * from the asset library, this names the asset. The scene then renders that
   * model as its base instead of primitive parts. Absent for primitive builds.
   *
   * Only reasoning/action/reply are truly required — everything below is
   * optional-with-a-safe-default so a response is rejected ONLY when it's
   * genuinely unusable, not because the model omitted a minor field.
   */
  baseAssetId: z.string().nullable().optional(),
  parts: z.array(partSchema).optional().default([]),
  removedPartIds: z.array(z.string()).optional().default([]),
  followUpQuestion: z.string().nullable().optional(),
  suggestedActions: z.array(z.string()).optional().default([]),
  /** Deterministic scene commands (scale/recolor/brighten/reframe). See sceneOpSchema. */
  sceneOps: z.array(sceneOpSchema).optional().default([]),
  /** Reserved for Phase 5 quiz mode; unused today. */
  quiz: z.unknown().nullable().optional(),
});
export type TutorResponse = z.infer<typeof tutorResponseSchema>;
