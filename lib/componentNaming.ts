/**
 * Server-only utility for semantic component naming.
 *
 * Given a GLB's submesh metadata, calls the explainer LLM to generate real
 * component names instead of junk like "Cone 1", "Mesh.001", etc.
 */
import { NodeIO, getBounds } from "@gltf-transform/core";
import type { Mesh, Object3D } from "three";
import { callExplainer } from "./llm";

export interface SubmeshMetadata {
  index: number;
  name: string;
  materialName: string | null;
  position: [number, number, number]; // normalized bbox center (-1..1)
  relativeVolume: number; // fraction of total
  vertexCount: number;
}

/**
 * Extract per-mesh metadata from a GLB file. Returns an array of metadata
 * objects suitable for passing to an LLM for semantic naming.
 */
export async function extractSubmeshMetadata(glbPath: string): Promise<SubmeshMetadata[]> {
  const io = new NodeIO();
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

  const meshes: Array<Mesh & { name: string }> = [];
  try {
    scene.traverse((obj: any) => {
      if (obj.isMesh) meshes.push(obj);
    });
  } catch {
    return [];
  }

  if (meshes.length === 0) return [];

  // Collect per-mesh metadata
  const metadata: SubmeshMetadata[] = meshes.map((mesh, index) => {
    // Compute bounds by collecting vertices from geometry
    const geometry = (mesh as any).geometry;
    let meshMin = [Infinity, Infinity, Infinity];
    let meshMax = [-Infinity, -Infinity, -Infinity];

    if (geometry?.attributes?.position) {
      const positions = geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < positions.length; i += 3) {
        meshMin[0] = Math.min(meshMin[0], positions[i]);
        meshMin[1] = Math.min(meshMin[1], positions[i + 1]);
        meshMin[2] = Math.min(meshMin[2], positions[i + 2]);
        meshMax[0] = Math.max(meshMax[0], positions[i]);
        meshMax[1] = Math.max(meshMax[1], positions[i + 1]);
        meshMax[2] = Math.max(meshMax[2], positions[i + 2]);
      }
    }

    // Fallback to simple bounds if no geometry
    if (!isFinite(meshMin[0])) {
      meshMin = [0, 0, 0];
      meshMax = [1, 1, 1];
    }

    const center = [
      (meshMin[0] + meshMax[0]) / 2,
      (meshMin[1] + meshMax[1]) / 2,
      (meshMin[2] + meshMax[2]) / 2,
    ];

    // Normalize center to -1..1 range relative to global bbox
    const normalized: [number, number, number] = [
      globalSize[0] > 1e-6 ? ((center[0] - globalMin[0]) / globalSize[0]) * 2 - 1 : 0,
      globalSize[1] > 1e-6 ? ((center[1] - globalMin[1]) / globalSize[1]) * 2 - 1 : 0,
      globalSize[2] > 1e-6 ? ((center[2] - globalMin[2]) / globalSize[2]) * 2 - 1 : 0,
    ];

    const meshVolume = (meshMax[0] - meshMin[0]) * (meshMax[1] - meshMin[1]) * (meshMax[2] - meshMin[2]);
    const relVol = globalVolume > 1e-6 ? meshVolume / globalVolume : 0;

    const matName =
      (mesh.material as any)?.name || (Array.isArray(mesh.material) ? mesh.material[0]?.name : null);

    // Count vertices
    const geo = mesh.geometry as any;
    const vertexCount = geo?.attributes?.position?.count || 0;

    return {
      index,
      name: mesh.name || `Mesh ${index}`,
      materialName: typeof matName === "string" ? matName : null,
      position: normalized,
      relativeVolume: relVol,
      vertexCount,
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
