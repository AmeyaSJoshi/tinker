/**
 * Server-only utility for semantic component naming.
 *
 * Given a GLB's submesh metadata, calls the explainer LLM to generate real
 * component names instead of junk like "Cone 1", "Mesh.001", etc.
 */
import { NodeIO, getBounds, type Accessor, type Node as GltfNode, type mat4 } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { callExplainer } from "./llm";

/** Transform a point by a column-major glTF mat4 (standard glTF/gl-matrix convention). */
function transformPoint(m: mat4, p: [number, number, number]): [number, number, number] {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

export interface SubmeshMetadata {
  index: number;
  name: string;
  materialName: string | null;
  position: [number, number, number]; // normalized bbox center (-1..1)
  relativeVolume: number; // fraction of total
  vertexCount: number;
}

/**
 * Extract per-PRIMITIVE metadata from a GLB file — one entry per draw call,
 * matching three.js's GLTFLoader granularity (which creates one Mesh per
 * primitive even when several primitives share a single node/mesh name). This
 * matters because plenty of these assets have exactly that shape: one node
 * named e.g. "Cone" whose mesh has 4 primitives, which three.js's client-side
 * loader renders — and this codebase's glbComponents.ts disambiguates — as
 * 4 separate components ("Cone 1".."Cone 4"). Grouping by NODE instead would
 * silently collapse all 4 into a single metadata entry, undercounting real
 * submeshes and mismatching the semantic names 1:1 against the client's
 * per-primitive component list.
 *
 * Uses @gltf-transform/core's own Node/Mesh/Primitive object model (NOT
 * three.js — this runs in Node, not a renderer, and gltf-transform's Node has
 * no `.isMesh` flag; that's a three.js-only concept a naive port of this code
 * once mistakenly assumed, which silently matched zero meshes on every asset).
 */
export async function extractSubmeshMetadata(glbPath: string): Promise<SubmeshMetadata[]> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(glbPath);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) return [];

  // Compute overall bounding box
  const { min: globalMin, max: globalMax } = getBounds(scene);
  const globalSize = [
    globalMax[0] - globalMin[0],
    globalMax[1] - globalMin[1],
    globalMax[2] - globalMin[2],
  ];
  const globalVolume = globalSize[0] * globalSize[1] * globalSize[2];

  interface Entry {
    node: GltfNode;
    name: string;
    posAccessor: Accessor | null;
    materialName: string | null;
  }
  const entries: Entry[] = [];

  try {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      const baseName = node.getName() || mesh.getName() || "Mesh";
      for (const primitive of mesh.listPrimitives()) {
        const posAccessor = primitive.getAttribute("POSITION");
        const material = primitive.getMaterial();
        entries.push({
          node,
          name: baseName,
          posAccessor,
          materialName: material?.getName() || null,
        });
      }
    });
  } catch {
    return [];
  }

  if (entries.length === 0) return [];

  const metadata: SubmeshMetadata[] = entries.map((entry, index) => {
    const worldMatrix = entry.node.getWorldMatrix();
    const posAccessor = entry.posAccessor;

    let localMin = [0, 0, 0];
    let localMax = [0, 0, 0];
    if (posAccessor) {
      localMin = posAccessor.getMin([0, 0, 0]);
      localMax = posAccessor.getMax([0, 0, 0]);
    }

    // Transform all 8 local corners into world space to get a true world AABB
    // (the node may be rotated/scaled, so min/max don't transform directly).
    let wMin: [number, number, number] = [Infinity, Infinity, Infinity];
    let wMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const sx of [localMin[0], localMax[0]]) {
      for (const sy of [localMin[1], localMax[1]]) {
        for (const sz of [localMin[2], localMax[2]]) {
          const [wx, wy, wz] = transformPoint(worldMatrix, [sx, sy, sz]);
          wMin = [Math.min(wMin[0], wx), Math.min(wMin[1], wy), Math.min(wMin[2], wz)];
          wMax = [Math.max(wMax[0], wx), Math.max(wMax[1], wy), Math.max(wMax[2], wz)];
        }
      }
    }

    const center: [number, number, number] = [
      (wMin[0] + wMax[0]) / 2,
      (wMin[1] + wMax[1]) / 2,
      (wMin[2] + wMax[2]) / 2,
    ];

    const normalized: [number, number, number] = [
      globalSize[0] > 1e-6 ? ((center[0] - globalMin[0]) / globalSize[0]) * 2 - 1 : 0,
      globalSize[1] > 1e-6 ? ((center[1] - globalMin[1]) / globalSize[1]) * 2 - 1 : 0,
      globalSize[2] > 1e-6 ? ((center[2] - globalMin[2]) / globalSize[2]) * 2 - 1 : 0,
    ];

    const meshVolume =
      Math.max(0, wMax[0] - wMin[0]) * Math.max(0, wMax[1] - wMin[1]) * Math.max(0, wMax[2] - wMin[2]);
    const relVol = globalVolume > 1e-6 ? meshVolume / globalVolume : 0;

    return {
      index,
      name: entry.name,
      materialName: entry.materialName,
      position: normalized,
      relativeVolume: relVol,
      vertexCount: posAccessor ? posAccessor.getCount() : 0,
    };
  });

  return metadata;
}

/**
 * Call the explainer LLM to name components based on their spatial positions
 * and sizes within a model. Returns an array of semantic names (one per submesh index).
 */
export async function getSemanticComponentNames(
  assetName: string,
  meshes: SubmeshMetadata[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (meshes.length === 0) return [];

  // Build a detailed description of each mesh for the LLM
  const meshDescriptions = meshes
    .map(
      (m) =>
        `Mesh ${m.index}: raw name "${m.name}"${m.materialName ? `, material "${m.materialName}"` : ""}, ` +
        `position in model (x=${m.position[0].toFixed(2)}, y=${m.position[1].toFixed(2)}, z=${m.position[2].toFixed(2)}) ` +
        `where -1=left/bottom/back, +1=right/top/front, ` +
        `relative volume ${(m.relativeVolume * 100).toFixed(1)}%, ${m.vertexCount} vertices`,
    )
    .join("\n");

  const prompt = `You are labeling the components of a 3D model of a "${assetName}".

Given each submesh's position within the model, its relative size, and its raw name, name what each part most likely is. Use real, specific component names (e.g., for a rocket: "Nosecone", "Fuselage", "Fin (left)", "Fin (right)", "Engine bell", "Nozzle", "Engine collar"). Duplicate-friendly names are fine ("Wheel (front)", "Wheel (rear)").

If a part is genuinely too ambiguous, use a descriptive guess ("Upper detail", "Connector plate"), never something generic like "Mesh 1" or "Cone 1".

Respond with ONLY a JSON array of strings, one per mesh in order. Example for a bike:
["Frame", "Front wheel", "Rear wheel", "Seat", "Handlebars", "Pedals"]

Mesh details:
${meshDescriptions}

Your response:`;

  try {
    const response = await callExplainer(prompt, signal);
    const trimmed = response.trim();

    // Extract JSON array from response (may have markdown, prose, etc. around it)
    const jsonMatch = trimmed.match(/\[\s*(?:"[^"]*"(?:\s*,\s*"[^"]*")*)\s*\]/);
    if (!jsonMatch) {
      console.warn(`[componentNaming] LLM did not return valid JSON array for "${assetName}"`);
      return meshes.map((m) => m.name);
    }

    const names = JSON.parse(jsonMatch[0]) as string[];
    if (!Array.isArray(names) || names.length !== meshes.length) {
      console.warn(
        `[componentNaming] LLM returned ${names.length} names, expected ${meshes.length} for "${assetName}"`,
      );
      return meshes.map((m) => m.name);
    }

    return names;
  } catch (err) {
    console.error(`[componentNaming] LLM call failed for "${assetName}":`, err);
    return meshes.map((m) => m.name);
  }
}

export interface VirtualComponent {
  name: string;
  position: [number, number, number]; // normalized -1..1
  whatItIs: string; // one-sentence description
}

/**
 * For single-mesh or minimal-mesh models, generate virtual component hotspots
 * by asking the LLM what logical components the model should have.
 */
export async function getVirtualComponents(
  assetName: string,
  signal?: AbortSignal,
): Promise<VirtualComponent[]> {
  const prompt = `A learner is looking at a 3D model of a "${assetName}". List its 4-8 real logical components, each with:
- name: the component name
- position: where on a typical ${assetName} would this component be, using normalized coordinates (x from -1=left to 1=right, y from -1=bottom to 1=top, z from -1=back to 1=front)
- whatItIs: a one-sentence description

Example for a "bike":
[
  { "name": "Frame", "position": [0, 0, 0], "whatItIs": "The structural backbone holding everything together." },
  { "name": "Front wheel", "position": [0, -0.7, -0.6], "whatItIs": "Rotates to propel and steer the bike forward." },
  { "name": "Rear wheel", "position": [0, -0.7, 0.6], "whatItIs": "Rotates to provide drive and stability." },
  { "name": "Seat", "position": [0, 0.8, 0.3], "whatItIs": "Where the rider sits to balance and control." },
  { "name": "Handlebars", "position": [0, 0.9, -0.8], "whatItIs": "Grips for steering and balance." },
  { "name": "Pedals", "position": [0, -0.3, 0], "whatItIs": "Where the rider applies power to the chain." },
  { "name": "Chain", "position": [0.3, -0.5, 0.3], "whatItIs": "Transfers power from pedals to rear wheel." }
]

Respond with ONLY a valid JSON array matching this schema — no markdown, no prose.`;

  try {
    const response = await callExplainer(prompt, signal);
    const trimmed = response.trim();

    // Extract JSON array
    const jsonMatch = trimmed.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!jsonMatch) {
      console.warn(`[virtualComponents] LLM did not return valid JSON array for "${assetName}"`);
      return [];
    }

    const components = JSON.parse(jsonMatch[0]) as VirtualComponent[];
    if (!Array.isArray(components)) {
      console.warn(`[virtualComponents] LLM response was not an array for "${assetName}"`);
      return [];
    }

    return components.filter((c) => c.name && c.position && c.whatItIs);
  } catch (err) {
    console.error(`[virtualComponents] LLM call failed for "${assetName}":`, err);
    return [];
  }
}
