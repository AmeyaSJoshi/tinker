"use client";

import { BASE_SELECTION_ID, useSceneStore } from "@/lib/sceneStore";

export default function ExplanationCard() {
  const selectedPartId = useSceneStore((s) => s.selectedPartId);
  const parts = useSceneStore((s) => s.parts);
  const baseAsset = useSceneStore((s) => s.baseAsset);
  const selectPart = useSceneStore((s) => s.selectPart);

  // Selecting the GLB base model shows its teacherly intro + concepts, so the
  // realistic base is just as explorable as the primitive parts on top of it.
  const card =
    selectedPartId === BASE_SELECTION_ID && baseAsset
      ? {
          name: baseAsset.name,
          color: "#6366f1",
          explanation: baseAsset.intro,
          concepts: baseAsset.concepts,
        }
      : parts.find((p) => p.id === selectedPartId);

  if (!card) return null;
  const part = card;

  return (
    <div className="pointer-events-auto absolute bottom-4 left-4 right-4 max-w-sm rounded-xl border border-lab-border bg-lab-panel/95 p-4 shadow-2xl backdrop-blur sm:right-auto">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className="h-3 w-3 flex-shrink-0 rounded-full"
            style={{ backgroundColor: part.color }}
            aria-hidden
          />
          <h3 className="text-base font-semibold text-white">{part.name}</h3>
        </div>
        <button
          onClick={() => selectPart(null)}
          className="flex-shrink-0 rounded-md px-2 py-0.5 text-sm text-gray-400 transition-colors hover:bg-lab-border hover:text-white"
          aria-label="Close explanation"
        >
          ✕
        </button>
      </div>

      <p className="text-sm leading-relaxed text-gray-300">
        {part.explanation}
      </p>

      {part.concepts.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {part.concepts.map((concept) => (
            <span
              key={concept}
              className="rounded-full border border-lab-border bg-lab-bg px-2 py-0.5 text-xs text-indigo-300"
            >
              {concept}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
