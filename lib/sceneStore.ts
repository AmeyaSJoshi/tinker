import { create } from "zustand";
import type {
  BaseAsset,
  ChatMessage,
  Part,
  PlacedAsset,
  SceneOp,
  TutorResponse,
} from "./schema";

/** Bounds on how far scale_base can shrink/grow the base model, total. */
const MIN_BASE_SCALE = 0.2;
const MAX_BASE_SCALE = 3;

/** A GLB submesh the learner clicked/hovered — identifies one inspectable component. */
export interface SelectedComponent {
  assetId: string;
  /** Grouping key used internally (name or material name); stable per load. */
  key: string;
  /** Cleaned, human-readable label shown in the tooltip + card. */
  label: string;
}

export type ComponentExplanationStatus = "loading" | "ready" | "error";
export interface ComponentExplanationEntry {
  status: ComponentExplanationStatus;
  text?: string;
}

/** One entry in the "Parts list" panel — mirrors a GlbComponent minus its mesh refs. */
export interface BaseComponentSummary {
  key: string;
  label: string;
}

/** Cache key for a component explanation: one entry per (assetId, component). */
export function componentCacheKey(assetId: string, key: string): string {
  return `${assetId}::${key}`;
}

function clampBaseScale(n: number): number {
  return Math.min(MAX_BASE_SCALE, Math.max(MIN_BASE_SCALE, n));
}

interface SceneState {
  /** The realistic GLB base model, if this build started from the asset library. */
  baseAsset: BaseAsset | null;
  /**
   * Multiple placed GLB base models for a COMPOUND build ("gaming setup").
   * Orthogonal to `baseAsset` — a compound scene leaves `baseAsset` null and
   * uses this instead; single-asset builds leave this empty and are
   * unaffected. See lib/schema.ts's `PlacedAsset`.
   */
  baseAssets: PlacedAsset[];
  /** Model ids the learner has rejected for the CURRENT build topic ("no, a real bike"). */
  rejectedModelIds: string[];
  parts: Part[];
  selectedPartId: string | null;
  /** The GLB submesh currently selected for inspection, if any. */
  selectedComponent: SelectedComponent | null;
  /** Cached component explanations, keyed by componentCacheKey(assetId, key). */
  componentExplanations: Record<string, ComponentExplanationEntry>;
  /** Detected components of the CURRENT base model, for the Parts list panel. */
  baseComponents: BaseComponentSummary[];
  conceptsLearned: string[];
  messages: ChatMessage[];

  /** Multiplier applied on top of the base asset's own scale (scale_base op). */
  baseScaleMultiplier: number;
  /** Hex color override applied to every material on the base model, if set. */
  baseColorOverride: string | null;
  /** Bumped each time a manual brighten_base op fires, so <BaseModel> can react. */
  baseBrightenRequestId: number;
  /** Bumped each time the camera should re-frame the scene (frame_all / reset_camera / button). */
  frameSignal: number;

  /** Load a realistic GLB as a FRESH build's base: sets it, clears parts + rejections. */
  loadBaseAsset: (asset: BaseAsset) => void;
  /**
   * Swap the current base model for a replacement (the learner rejected the old
   * one). Remembers the rejected model's id so it's never re-picked this topic.
   */
  swapBaseAsset: (asset: BaseAsset) => void;
  /**
   * Load a COMPOUND scene composed of multiple placed GLB models plus any
   * primitive-fallback components (already positioned into world space).
   * Replaces whatever was in the scene, same as `loadBaseAsset`.
   */
  loadComposedScene: (data: { baseAssets: PlacedAsset[]; parts: Part[]; concepts?: string[] }) => void;
  /** Apply a validated tutor response to the scene per the manifest rules. */
  applyManifest: (response: TutorResponse) => void;
  /** Apply the response's deterministic sceneOps (scale/recolor/brighten/reframe). */
  applySceneOps: (ops: SceneOp[]) => void;
  selectPart: (id: string | null) => void;
  /** Select a GLB submesh for inspection; clears any primitive-part selection. */
  selectComponent: (component: SelectedComponent) => void;
  setComponentExplanation: (cacheKey: string, entry: ComponentExplanationEntry) => void;
  /** Publish the current base model's detected components for the Parts list panel. */
  setBaseComponents: (components: BaseComponentSummary[]) => void;
  /** Manually request a camera reframe (the "⛶ Reset view" button). */
  requestFrame: () => void;
  addMessage: (message: ChatMessage) => void;
  clearScene: () => void;
}

/** Merge concept tags from a set of parts into the running list, de-duped. */
function mergeConcepts(existing: string[], parts: Part[]): string[] {
  const next = new Set(existing);
  for (const part of parts) {
    for (const concept of part.concepts) next.add(concept);
  }
  return Array.from(next);
}

export const useSceneStore = create<SceneState>((set) => ({
  baseAsset: null,
  baseAssets: [],
  rejectedModelIds: [],
  parts: [],
  selectedPartId: null,
  selectedComponent: null,
  componentExplanations: {},
  baseComponents: [],
  conceptsLearned: [],
  messages: [],
  baseScaleMultiplier: 1,
  baseColorOverride: null,
  baseBrightenRequestId: 0,
  frameSignal: 0,

  loadBaseAsset: (asset) =>
    set((state) => ({
      baseAsset: asset,
      // A single-asset build replaces any compound scene that was loaded.
      baseAssets: [],
      // A new build topic — start the rejection list over.
      rejectedModelIds: [],
      // A new base model replaces whatever was in the scene.
      parts: [],
      selectedPartId: null,
      selectedComponent: null,
      baseComponents: [],
      // A fresh model starts at its own default look, not the old one's edits.
      baseScaleMultiplier: 1,
      baseColorOverride: null,
      conceptsLearned: Array.from(
        new Set([...state.conceptsLearned, ...asset.concepts]),
      ),
    })),

  swapBaseAsset: (asset) =>
    set((state) => {
      const rejectedId = state.baseAsset?.sourceModelId;
      return {
        baseAsset: asset,
        baseAssets: [],
        rejectedModelIds: rejectedId
          ? Array.from(new Set([...state.rejectedModelIds, rejectedId]))
          : state.rejectedModelIds,
        parts: [],
        selectedPartId: null,
        selectedComponent: null,
        baseComponents: [],
        baseScaleMultiplier: 1,
        baseColorOverride: null,
        conceptsLearned: Array.from(
          new Set([...state.conceptsLearned, ...asset.concepts]),
        ),
      };
    }),

  loadComposedScene: ({ baseAssets, parts, concepts = [] }) =>
    set((state) => ({
      baseAsset: null,
      baseAssets,
      rejectedModelIds: [],
      parts,
      selectedPartId: null,
      selectedComponent: null,
      baseComponents: [],
      baseScaleMultiplier: 1,
      baseColorOverride: null,
      // A fresh compound scene needs a fresh camera frame too.
      frameSignal: state.frameSignal + 1,
      conceptsLearned: Array.from(
        new Set([
          ...state.conceptsLearned,
          ...concepts,
          ...baseAssets.flatMap((pa) => pa.asset.concepts),
        ]),
      ),
    })),

  applyManifest: (response) =>
    set((state) => {
      const { action, parts, removedPartIds } = response;

      // A primitives create_base means the learner is building from scratch —
      // drop any GLB base model that was previously loaded.
      const nextBaseAsset =
        action === "create_base" ? null : state.baseAsset;

      let nextParts: Part[];

      switch (action) {
        // Replace the whole scene with the incoming parts.
        case "create_base":
          nextParts = [...parts];
          break;

        // Merge incoming parts into the scene; incoming ids overwrite matches.
        case "add_parts": {
          const incomingIds = new Set(parts.map((p) => p.id));
          nextParts = [
            ...state.parts.filter((p) => !incomingIds.has(p.id)),
            ...parts,
          ];
          break;
        }

        // Replace only the parts whose ids match incoming parts.
        case "modify_parts": {
          const byId = new Map(parts.map((p) => [p.id, p]));
          nextParts = state.parts.map((p) => byId.get(p.id) ?? p);
          // Also add any modified parts that weren't already present.
          for (const p of parts) {
            if (!state.parts.some((existing) => existing.id === p.id)) {
              nextParts.push(p);
            }
          }
          break;
        }

        // "explain" touches no geometry; keep the scene as-is.
        case "explain":
        default:
          nextParts = state.parts;
          break;
      }

      // Apply removals last so a manifest can add and remove in one turn.
      if (removedPartIds.length > 0) {
        const removed = new Set(removedPartIds);
        nextParts = nextParts.filter((p) => !removed.has(p.id));
      }

      // If the selected part was removed, clear the selection.
      const stillSelected =
        state.selectedPartId != null &&
        nextParts.some((p) => p.id === state.selectedPartId);

      return {
        baseAsset: nextBaseAsset,
        parts: nextParts,
        selectedPartId: stillSelected ? state.selectedPartId : null,
        conceptsLearned: mergeConcepts(state.conceptsLearned, parts),
      };
    }),

  applySceneOps: (ops) =>
    set((state) => {
      if (ops.length === 0) return state;

      let baseScaleMultiplier = state.baseScaleMultiplier;
      let baseColorOverride = state.baseColorOverride;
      let baseBrightenRequestId = state.baseBrightenRequestId;
      let frameSignal = state.frameSignal;
      let parts = state.parts;

      for (const op of ops) {
        switch (op.op) {
          case "scale_base":
            baseScaleMultiplier = clampBaseScale(baseScaleMultiplier * op.factor);
            // A resize is only useful if the camera reframes to match.
            frameSignal += 1;
            break;
          case "recolor_base":
            baseColorOverride = op.color;
            break;
          case "recolor_part":
            parts = parts.map((p) =>
              p.id === op.partId ? { ...p, color: op.color } : p,
            );
            break;
          case "brighten_base":
            baseBrightenRequestId += 1;
            break;
          case "reset_camera":
          case "frame_all":
            frameSignal += 1;
            break;
        }
      }

      return {
        baseScaleMultiplier,
        baseColorOverride,
        baseBrightenRequestId,
        frameSignal,
        parts,
      };
    }),

  selectPart: (id) => set({ selectedPartId: id, selectedComponent: null }),

  selectComponent: (component) =>
    set({ selectedComponent: component, selectedPartId: null }),

  setComponentExplanation: (cacheKey, entry) =>
    set((state) => ({
      componentExplanations: { ...state.componentExplanations, [cacheKey]: entry },
    })),

  setBaseComponents: (components) => set({ baseComponents: components }),

  requestFrame: () => set((state) => ({ frameSignal: state.frameSignal + 1 })),

  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  clearScene: () =>
    set({
      baseAsset: null,
      baseAssets: [],
      rejectedModelIds: [],
      parts: [],
      selectedPartId: null,
      selectedComponent: null,
      baseComponents: [],
      conceptsLearned: [],
      messages: [],
      baseScaleMultiplier: 1,
      baseColorOverride: null,
      baseBrightenRequestId: 0,
      frameSignal: 0,
    }),
}));
