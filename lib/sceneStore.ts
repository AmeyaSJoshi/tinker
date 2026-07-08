import { create } from "zustand";
import type { BaseAsset, ChatMessage, Part, TutorResponse } from "./schema";

/** Reserved selection id used when the GLB base MODEL itself is clicked. */
export const BASE_SELECTION_ID = "__base_asset__";

interface SceneState {
  /** The realistic GLB base model, if this build started from the asset library. */
  baseAsset: BaseAsset | null;
  parts: Part[];
  selectedPartId: string | null;
  conceptsLearned: string[];
  messages: ChatMessage[];

  /** Load a realistic GLB as the scene's base: sets it and clears any parts. */
  loadBaseAsset: (asset: BaseAsset) => void;
  /** Apply a validated tutor response to the scene per the manifest rules. */
  applyManifest: (response: TutorResponse) => void;
  selectPart: (id: string | null) => void;
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
  parts: [],
  selectedPartId: null,
  conceptsLearned: [],
  messages: [],

  loadBaseAsset: (asset) =>
    set((state) => ({
      baseAsset: asset,
      // A new base model replaces whatever was in the scene.
      parts: [],
      selectedPartId: null,
      conceptsLearned: Array.from(
        new Set([...state.conceptsLearned, ...asset.concepts]),
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

      // If the selected part was removed, clear the selection. The base-model
      // selection stays valid as long as a base model is still present.
      const stillSelected =
        state.selectedPartId != null &&
        ((state.selectedPartId === BASE_SELECTION_ID && nextBaseAsset != null) ||
          nextParts.some((p) => p.id === state.selectedPartId));

      return {
        baseAsset: nextBaseAsset,
        parts: nextParts,
        selectedPartId: stillSelected ? state.selectedPartId : null,
        conceptsLearned: mergeConcepts(state.conceptsLearned, parts),
      };
    }),

  selectPart: (id) => set({ selectedPartId: id }),

  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  clearScene: () =>
    set({
      baseAsset: null,
      parts: [],
      selectedPartId: null,
      conceptsLearned: [],
      messages: [],
    }),
}));
