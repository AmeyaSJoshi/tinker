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
 * Optional anchor-based attachment. When a part attaches to a GLB base MODEL,
 * the tutor may name one of the model's auto-anchors (top / bottom / front /
 * rear / left_side / right_side / center) instead of guessing coordinates; the
 * server resolves it to a real world position (plus an optional local offset)
 * before the part is rendered. Absent = use `position` verbatim (primitive-only
 * builds work exactly as before).
 */
export const attachToSchema = z.object({
  anchor: z.string().min(1),
  offset: vec3.optional(),
});
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
});
export type Part = z.infer<typeof partSchema>;

export const actionSchema = z.enum([
  "create_base",
  "add_parts",
  "modify_parts",
  "explain",
]);
export type Action = z.infer<typeof actionSchema>;

/**
 * A single chat turn. `role` mirrors the sender; `content` is the human-readable
 * text (the tutor's `reply`, never raw JSON). Sent to the API so Gemini — which
 * is stateless — has the full conversation on every request.
 */
export interface ChatMessage {
  role: "user" | "tutor";
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
   */
  baseAssetId: z.string().optional(),
  parts: z.array(partSchema).default([]),
  removedPartIds: z.array(z.string()).default([]),
  followUpQuestion: z.string().optional(),
  suggestedActions: z.array(z.string()).default([]),
});
export type TutorResponse = z.infer<typeof tutorResponseSchema>;
