"use client";

import { useEffect, useState } from "react";

interface CreditEntry {
  slug: string;
  name: string;
  author: string;
  license: string;
  url: string;
  /** The API's pre-formatted CC-BY credit line — the actual compliance text. */
  attribution: string;
}

/**
 * A small "Model credits" link pinned to the viewport corner. Opens a modal
 * listing attribution for every downloaded model — CC-BY compliance with zero
 * manual effort, since the ledger is fed automatically by every download.
 */
export default function CreditsFooter() {
  const [open, setOpen] = useState(false);
  const [credits, setCredits] = useState<CreditEntry[] | null>(null);

  useEffect(() => {
    if (!open || credits) return;
    fetch("/api/credits")
      .then((r) => r.json())
      .then((d) => setCredits(Array.isArray(d?.credits) ? d.credits : []))
      .catch(() => setCredits([]));
  }, [open, credits]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="absolute bottom-3 right-3 z-10 rounded-md border border-lab-border bg-lab-panel/80 px-2.5 py-1 text-[11px] text-gray-400 backdrop-blur transition-colors hover:border-lab-accent hover:text-white"
      >
        Model credits
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[70vh] w-full max-w-md overflow-y-auto rounded-xl border border-lab-border bg-lab-panel p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">
                Model credits
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-0.5 text-sm text-gray-400 hover:bg-lab-border hover:text-white"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <p className="mb-3 text-xs text-gray-400">
              3D models sourced from{" "}
              <a
                href="https://poly.pizza"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-300 hover:underline"
              >
                Poly Pizza
              </a>
              ,{" "}
              <a
                href="https://kenney.nl/assets"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-300 hover:underline"
              >
                Kenney
              </a>
              , and{" "}
              <a
                href="https://sketchfab.com"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-300 hover:underline"
              >
                Sketchfab
              </a>
              . CC0 and CC-BY, attributed below.
            </p>

            {credits === null ? (
              <p className="text-sm text-gray-500">Loading…</p>
            ) : credits.length === 0 ? (
              <p className="text-sm text-gray-500">
                No models downloaded yet. Run{" "}
                <code className="rounded bg-lab-bg px-1">npm run fetch-assets</code>{" "}
                or build something that fetches one live.
              </p>
            ) : (
              <ul className="space-y-2">
                {credits.map((c) => (
                  <li
                    key={c.slug}
                    className="rounded-lg border border-lab-border bg-lab-bg px-3 py-2 text-sm"
                  >
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-white hover:underline"
                    >
                      {c.name}
                    </a>{" "}
                    <span className="text-gray-500">by</span>{" "}
                    <span className="text-gray-300">{c.author}</span>
                    <span className="ml-2 rounded-full border border-lab-border px-1.5 py-0.5 text-[10px] text-gray-400">
                      {c.license}
                    </span>
                    <p className="mt-1 text-[11px] leading-snug text-gray-500">
                      {c.attribution}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
