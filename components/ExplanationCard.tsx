"use client";

import { useEffect } from "react";
import { componentCacheKey, useSceneStore } from "@/lib/sceneStore";

/** Matches the whole-model fallback key from lib/glbComponents.ts. */
const WHOLE_MODEL_KEY = "__whole__";

/**
 * Shows an explanation for whatever is currently selected: a primitive part,
 * or a GLB submesh ("component") clicked on a realistic base model. Component
 * explanations are fetched lazily from /api/explain-component and cached in
 * the store per (assetId, componentKey) so a repeat click is instant.
 */
export default function ExplanationCard() {
  const selectedPartId = useSceneStore((s) => s.selectedPartId);
  const selectedComponent = useSceneStore((s) => s.selectedComponent);
  const parts = useSceneStore((s) => s.parts);
  const baseAsset = useSceneStore((s) => s.baseAsset);
  const componentExplanations = useSceneStore((s) => s.componentExplanations);
  const selectPart = useSceneStore((s) => s.selectPart);
  const setComponentExplanation = useSceneStore((s) => s.setComponentExplanation);

  // Fetch (once, cached) the explanation for a newly-selected GLB component.
  // The "whole model" fallback skips the network call — it just reuses the
  // asset's own teacherly intro, since there's nothing more specific to ask.
  useEffect(() => {
    if (!selectedComponent || !baseAsset) return;
    if (selectedComponent.key === WHOLE_MODEL_KEY) return;

    const key = componentCacheKey(selectedComponent.assetId, selectedComponent.key);
    if (useSceneStore.getState().componentExplanations[key]) return;

    setComponentExplanation(key, { status: "loading" });
    const startedAt = performance.now();
    fetch("/api/explain-component", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetName: baseAsset.name,
        componentName: selectedComponent.label,
      }),
    })
      .then((res) => res.json())
      .then((data: { explanation?: string }) => {
        if (process.env.NODE_ENV !== "production") {
          console.info(
            `[explain-component] "${selectedComponent.label}" answered in ${Math.round(performance.now() - startedAt)}ms`,
          );
        }
        const text = typeof data?.explanation === "string" ? data.explanation.trim() : "";
        setComponentExplanation(
          key,
          text
            ? { status: "ready", text }
            : {
                status: "error",
                text: `I couldn't find much on the ${selectedComponent.label} — try clicking another part.`,
              },
        );
      })
      .catch(() => {
        setComponentExplanation(key, {
          status: "error",
          text: `I couldn't reach the tutor to explain the ${selectedComponent.label} — try again in a moment.`,
        });
      });
  }, [selectedComponent, baseAsset, setComponentExplanation]);

  if (selectedComponent && baseAsset) {
    const isWhole = selectedComponent.key === WHOLE_MODEL_KEY;
    const cacheKey = componentCacheKey(selectedComponent.assetId, selectedComponent.key);
    const cached = componentExplanations[cacheKey];
    const explanation = isWhole ? baseAsset.intro : (cached?.text ?? null);

    return (
      <div className="pointer-events-auto absolute bottom-4 left-4 right-4 max-w-sm rounded-xl border border-lab-border bg-lab-panel/95 p-4 shadow-2xl backdrop-blur sm:right-auto">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 flex-shrink-0 rounded-full bg-indigo-500" aria-hidden />
            <h3 className="text-base font-semibold text-white">
              {selectedComponent.label}
            </h3>
          </div>
          <button
            onClick={() => selectPart(null)}
            className="flex-shrink-0 rounded-md px-2 py-0.5 text-sm text-gray-400 transition-colors hover:bg-lab-border hover:text-white"
            aria-label="Close explanation"
          >
            ✕
          </button>
        </div>

        {explanation != null ? (
          <p className="text-sm leading-relaxed text-gray-300">{explanation}</p>
        ) : (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <span className="h-3 w-3 flex-shrink-0 animate-spin rounded-full border-2 border-indigo-400/40 border-t-indigo-400" />
            Thinking…
          </div>
        )}
      </div>
    );
  }

  const part = parts.find((p) => p.id === selectedPartId);
  if (!part) return null;

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
