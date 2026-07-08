/**
 * Compound-scene decomposition prompt + schema (SERVER-ONLY).
 *
 * Turns a multi-object request ("gaming setup") into 2-6 named components with
 * a rough floor-grid layout, BEFORE any asset resolution happens. Each
 * component is resolved independently afterward (see app/api/compose-scene).
 */
import { z } from "zod";

export const compoundComponentSchema = z.object({
  /** Short display name, e.g. "Desk", "Monitor". */
  name: z.string().min(1),
  /** What to search/build for this component — a clean, specific object phrase. */
  searchPhrase: z.string().min(1),
  /** Floor-grid position in small arbitrary units (roughly -3..3), ignored if onSurface is set. */
  gridX: z.number(),
  gridZ: z.number(),
  /**
   * This component's REAL-WORLD height in meters (e.g. a desk ~0.75, a
   * monitor ~0.45, a mouse ~0.03). Every fetched/built asset is otherwise
   * normalized to the same baseline size, so this is what keeps a mouse from
   * rendering as tall as a desk in a compound scene.
   */
  targetHeight: z.number().positive().max(20),
  /** The exact `name` of another component in this same list that this one sits ON, or null for the floor. */
  onSurface: z.string().nullable().optional(),
});
export type CompoundComponent = z.infer<typeof compoundComponentSchema>;

export const compoundLayoutSchema = z.object({
  components: z.array(compoundComponentSchema).min(2).max(6),
  /** One sentence introducing the composed scene, teaching how the pieces relate. */
  intro: z.string().min(1),
});
export type CompoundLayout = z.infer<typeof compoundLayoutSchema>;

export function buildComposeScenePrompt(phrase: string): string {
  return `You are BuildLab's scene planner. A learner asked to build "${phrase}" — a request for MULTIPLE distinct objects arranged together, not one single thing.

Decompose it into 2 to 6 concrete, individually-buildable components, and lay them out on a floor grid.

Grid rules:
- gridX and gridZ are small arbitrary units, roughly in the range -3 to 3. [0,0] is the center of the scene.
- Space floor-standing components at least 1.5 grid units apart so they don't overlap.
- A component that sits ON TOP of another (a monitor on a desk, a lamp on a nightstand) sets "onSurface" to the EXACT "name" string of that other component; its own gridX/gridZ are then ignored (it inherits the surface's position). A component resting on the floor sets "onSurface" to null.
- "searchPhrase" should be a clean, specific, single-object phrase suitable for a 3D asset search — not the whole original request.
- "targetHeight" is this component's REAL height in meters — think about actual proportions relative to its neighbors (a desk is much taller than a mouse, a planet is tiny next to a sun). This is the ONLY thing that keeps every object from rendering at the same size, so take it seriously: a desk ≈ 0.7-0.8, an office chair ≈ 1.0-1.2, a monitor ≈ 0.35-0.5, a keyboard ≈ 0.02-0.04, a mouse ≈ 0.03-0.05, a PC tower ≈ 0.4-0.5, a person ≈ 1.7, a car ≈ 1.5, a house ≈ 6-8.

### Example — "gaming setup"
{
  "components": [
    { "name": "Desk", "searchPhrase": "office desk", "gridX": 0, "gridZ": 0, "targetHeight": 0.75, "onSurface": null },
    { "name": "Monitor", "searchPhrase": "computer monitor", "gridX": 0, "gridZ": 0, "targetHeight": 0.42, "onSurface": "Desk" },
    { "name": "PC Tower", "searchPhrase": "gaming pc tower", "gridX": 1.8, "gridZ": 0, "targetHeight": 0.45, "onSurface": null },
    { "name": "Keyboard", "searchPhrase": "computer keyboard", "gridX": -0.5, "gridZ": 0, "targetHeight": 0.03, "onSurface": "Desk" },
    { "name": "Gaming Chair", "searchPhrase": "gaming chair", "gridX": 0, "gridZ": 1.8, "targetHeight": 1.1, "onSurface": null }
  ],
  "intro": "Here's a gaming setup: a desk anchors the monitor and keyboard at the right height, while the tower and chair sit on the floor around it so cables can run short and everything is reachable from one seat."
}

### Example — "solar system"
{
  "components": [
    { "name": "Sun", "searchPhrase": "sun star", "gridX": 0, "gridZ": 0, "targetHeight": 2.4, "onSurface": null },
    { "name": "Mercury", "searchPhrase": "small rocky planet", "gridX": 1.2, "gridZ": 0, "targetHeight": 0.3, "onSurface": null },
    { "name": "Earth", "searchPhrase": "earth planet", "gridX": 2.2, "gridZ": 0, "targetHeight": 0.4, "onSurface": null },
    { "name": "Mars", "searchPhrase": "mars planet", "gridX": 3, "gridZ": 0.6, "targetHeight": 0.35, "onSurface": null }
  ],
  "intro": "Here's a scaled-down solar system: the sun at the center with rocky planets spaced outward, so you can see how orbital distance grows the further out you go."
}

Reply with ONLY one JSON object matching this shape, nothing else — no markdown fences, no prose before or after:
{
  "components": [ { "name": "...", "searchPhrase": "...", "gridX": 0, "gridZ": 0, "targetHeight": 0.5, "onSurface": null } ],
  "intro": "One sentence introducing the composed scene."
}`;
}
