"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSceneStore } from "@/lib/sceneStore";
import {
  tutorResponseSchema,
  type BaseAsset,
  type ChatMessage,
  type TutorResponse,
} from "@/lib/schema";
import { demoScenes, parseDemoCommand } from "@/lib/demoScenes";
import { SCENE_COMMAND_RE } from "@/lib/sceneCommandHeuristics";

const WELCOME =
  "What do you want to build today? Tell me something like “a spaceship” and I’ll bring it to life in 3D — then we’ll upgrade it together.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Words that signal a fresh build request rather than an edit/question. */
const CREATE_RE =
  /\b(build|make|create|design|construct|model|show me|give me|generate|render|i want|i'?d like)\b/i;

/**
 * Words that signal the learner is rejecting the CURRENT base model rather
 * than asking for an edit ("no, a real bike", "that's not right", "wrong
 * one"). Checked only when a base model is loaded — a plain keyword heuristic
 * beats an extra LLM round-trip here since it just needs to be reliable, not
 * subtle.
 */
const REJECT_RE =
  /\b(not this|not that|wrong (one|model|thing)|a real |an actual |that'?s not (it|right)|no,? i (wanted|meant)|try (a different|another)|different (one|model))\b/i;

/**
 * Decide whether a message should first try to resolve to a realistic base
 * MODEL (via /api/resolve-asset). A clear "build/make" verb always qualifies;
 * so does the very first message when nothing exists yet, unless it's obviously
 * a question. Edits like "add a fin" on an existing scene do NOT.
 */
function looksLikeCreate(text: string, hasScene: boolean): boolean {
  if (hasScene && SCENE_COMMAND_RE.test(text)) return false;
  if (CREATE_RE.test(text)) return true;
  if (!hasScene) {
    if (/\?|^(why|how|what|explain|tell me|describe)\b/i.test(text.trim())) {
      return false;
    }
    return true;
  }
  return false;
}

/** Client-side noun guess, only for the lively status line ("…a lighthouse…"). */
function coreNoun(text: string): string {
  let s = text.toLowerCase().trim().replace(/[.?!]+$/g, "");
  s = s.replace(
    /^(please\s+)?(can you\s+|could you\s+)?(i\s+(want|wanna|would like|'?d like)\s+(to\s+)?)?((build|make|create|design|show me|give me|draw|model|render|let'?s\s+(build|make|create)|add)\s+)?/,
    "",
  );
  s = s.replace(/^(a|an|the|some|my)\s+/, "");
  s = s.replace(/\s+(please|for me|now)$/g, "");
  return s.trim() || "model";
}

/** Starter chips shown right after a base MODEL loads. */
function baseAssetSuggestions(asset: BaseAsset): string[] {
  const name = asset.name.toLowerCase();
  const why = asset.concepts[0]
    ? `Explain ${asset.concepts[0]}`
    : `How does this ${name} work?`;
  return [`Add a part to the ${name}`, why, "Build something else"];
}

export default function ChatPanel() {
  const messages = useSceneStore((s) => s.messages);
  const addMessage = useSceneStore((s) => s.addMessage);
  const applyManifest = useSceneStore((s) => s.applyManifest);
  const applySceneOps = useSceneStore((s) => s.applySceneOps);
  const loadBaseAsset = useSceneStore((s) => s.loadBaseAsset);
  const swapBaseAsset = useSceneStore((s) => s.swapBaseAsset);
  const clearScene = useSceneStore((s) => s.clearScene);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A lively "finding you a realistic X…" line shown while a live fetch runs.
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  // Chips from the latest tutor turn; cleared while a request is in flight.
  const [suggestedActions, setSuggestedActions] = useState<string[]>([]);
  // Which models are answering — shown as a small badge for A/B visibility.
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [explainerLabel, setExplainerLabel] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  // The in-flight resolve-asset/tutor fetch for the current turn, if any —
  // aborting it is what the Stop button does.
  const abortRef = useRef<AbortController | null>(null);

  function isAbortError(err: unknown): boolean {
    return err instanceof DOMException && err.name === "AbortError";
  }

  // Ask the server which brain is currently ACTIVE (never exposes the key). The
  // active model can change mid-session (auto-switch after repeated failures),
  // so we refresh this after every tutor turn as well as on mount.
  const refreshModelBadge = useCallback(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.tutorModel === "string") setModelLabel(d.tutorModel);
        if (typeof d?.explainerModel === "string") setExplainerLabel(d.explainerModel);
      })
      .catch(() => {
        /* badge is non-essential; ignore failures */
      });
  }, []);

  useEffect(() => {
    refreshModelBadge();
  }, [refreshModelBadge]);

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading, liveStatus]);

  /**
   * Hidden demo-day insurance. Replays a scripted build sequence entirely
   * offline (no API), with fake latency so it feels live. Invisible in the UI —
   * only triggered by typing "/demo spaceship" (or volcano / heart).
   */
  async function playDemo(name: keyof typeof demoScenes) {
    const sequence = demoScenes[name];
    setError(null);
    setSuggestedActions([]);
    // Start from a clean slate so the scripted build looks pristine.
    clearScene();

    for (const step of sequence) {
      setLoading(true);
      await sleep(800);
      setLoading(false);
      applyManifest(step);
      applySceneOps(step.sceneOps ?? []);
      addMessage({ role: "tutor", content: step.reply });
      setSuggestedActions(step.suggestedActions ?? []);
      // Small beat between steps so parts visibly assemble one stage at a time.
      await sleep(200);
    }
  }

  /**
   * Try to resolve a build request to a realistic base MODEL. Null = use
   * primitives. An abort (the learner hit Stop) is rethrown rather than
   * swallowed as "no match" — otherwise stopping mid-search would silently
   * chain into a primitives build instead of actually stopping.
   */
  async function resolveAsset(
    phrase: string,
    excludeIds: string[] | undefined,
    signal: AbortSignal,
  ): Promise<BaseAsset | null> {
    try {
      const res = await fetch("/api/resolve-asset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase, excludeIds }),
        signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      if ((data?.status === "library" || data?.status === "live") && data.asset) {
        return data.asset as BaseAsset;
      }
      return null;
    } catch (err) {
      if (isAbortError(err)) throw err;
      return null;
    }
  }

  /** Call the tutor for a primitives build/edit and apply the result. */
  async function runTutor(
    text: string,
    priorHistory: ChatMessage[],
    baseAssetId: string | undefined,
    signal: AbortSignal,
  ) {
    const res = await fetch("/api/tutor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        // "note" turns (e.g. "Stopped.") are UI-only — never send them as
        // conversation history to the (stateless) model.
        history: priorHistory.filter((m) => m.role !== "note"),
        currentParts: useSceneStore.getState().parts,
        baseAssetId,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);

    const data = await res.json();
    const parsed = tutorResponseSchema.safeParse(data);
    if (!parsed.success) throw new Error("Malformed tutor response");

    const response: TutorResponse = parsed.data;
    applyManifest(response);
    applySceneOps(response.sceneOps ?? []);
    addMessage({ role: "tutor", content: response.reply });
    setSuggestedActions(response.suggestedActions ?? []);
  }

  /** Send a message: resolve a base model for creates, else drive the tutor. */
  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    // Intercept the hidden demo command before it ever hits the network.
    const demo = parseDemoCommand(trimmed);
    if (demo) {
      setInput("");
      void playDemo(demo);
      return;
    }

    setError(null);
    setInput("");
    setSuggestedActions([]);

    // Snapshot state BEFORE adding the new user turn.
    const priorHistory = useSceneStore.getState().messages;
    const before = useSceneStore.getState();
    const hasScene = before.baseAsset != null || before.parts.length > 0;
    addMessage({ role: "user", content: trimmed });
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Rejecting the current base model ("no, a real bike") re-resolves the
      // SAME topic with the old model excluded, instead of falling through to
      // the tutor (which would just edit primitives onto the wrong model).
      if (before.baseAsset && REJECT_RE.test(trimmed)) {
        const rejected = before.baseAsset;
        const noun = rejected.name.toLowerCase();
        const exclude = rejected.sourceModelId
          ? Array.from(new Set([...before.rejectedModelIds, rejected.sourceModelId]))
          : before.rejectedModelIds;

        setLiveStatus(`🔍 Let me find a better ${noun}…`);
        const next = await resolveAsset(rejected.name, exclude, controller.signal);
        setLiveStatus(null);

        if (next) {
          swapBaseAsset(next);
          addMessage({
            role: "tutor",
            content: `Let me find a better ${noun}… ${next.intro}`,
          });
          setSuggestedActions(baseAssetSuggestions(next));
        } else {
          addMessage({
            role: "tutor",
            content: `I couldn't find a better match for "${noun}" online — want to describe it differently, or should I build one from scratch instead?`,
          });
          setSuggestedActions([`Build a ${noun} from scratch`, "Describe it differently"]);
        }
        return;
      }

      if (looksLikeCreate(trimmed, hasScene)) {
        setLiveStatus(`🔍 Finding you a realistic ${coreNoun(trimmed)}…`);
        const asset = await resolveAsset(trimmed, undefined, controller.signal);
        setLiveStatus(null);
        if (asset) {
          loadBaseAsset(asset);
          addMessage({ role: "tutor", content: asset.intro });
          setSuggestedActions(baseAssetSuggestions(asset));
          return;
        }
        // No realistic model — build it from primitives instead (no base).
        await runTutor(trimmed, priorHistory, undefined, controller.signal);
        return;
      }

      // Edit / question on the existing scene. Carry the base asset id (if any)
      // so the tutor gets its anchors and can attach parts precisely.
      await runTutor(trimmed, priorHistory, before.baseAsset?.id, controller.signal);
    } catch (err) {
      if (isAbortError(err)) {
        addMessage({ role: "note", content: "Stopped." });
      } else {
        console.error(err);
        setError(
          "I couldn’t reach the tutor just now. Check your connection and try again.",
        );
      }
    } finally {
      setLiveStatus(null);
      setLoading(false);
      abortRef.current = null;
      // The active model may have auto-switched this turn — keep the badge honest.
      refreshModelBadge();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void send(input);
  }

  /** Stop button: aborts the in-flight fetch. The catch block in send() takes it from there. */
  function handleStop() {
    abortRef.current?.abort();
  }

  return (
    <div className="flex h-full flex-col border-r border-lab-border bg-lab-panel">
      {/* Header */}
      <header className="border-b border-lab-border px-5 py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xl">🛠️</span>
            <h1 className="text-lg font-bold tracking-tight text-white">
              BuildLab
            </h1>
          </div>
          {(modelLabel || explainerLabel) && (
            <div
              className="flex flex-shrink-0 flex-col items-end gap-0.5 text-[11px] leading-tight text-gray-400"
              title="Models currently answering: 🧠 tutor (build/modify) · ⚡ explainer (fast Q&A)"
            >
              {modelLabel && (
                <span className="whitespace-nowrap rounded-full border border-lab-border bg-lab-bg px-2 py-0.5">
                  🧠 {modelLabel}
                </span>
              )}
              {explainerLabel && (
                <span className="whitespace-nowrap rounded-full border border-lab-border bg-lab-bg px-2 py-0.5">
                  ⚡ {explainerLabel}
                </span>
              )}
            </div>
          )}
        </div>
        <p className="mt-0.5 text-xs text-gray-400">
          Learn science &amp; engineering by building it.
        </p>
      </header>

      {/* Message list */}
      <div
        ref={scrollRef}
        className="flex-1 space-y-4 overflow-y-auto px-5 py-5"
      >
        {/* Persistent welcome bubble */}
        <TutorBubble text={WELCOME} />

        {messages.map((m, i) => {
          if (m.role === "tutor") return <TutorBubble key={i} text={m.content} />;
          if (m.role === "note") return <NoteLine key={i} text={m.content} />;
          return <UserBubble key={i} text={m.content} />;
        })}

        {/* Live-fetch status takes over from the typing dots while we search. */}
        {liveStatus ? (
          <StatusBubble text={liveStatus} />
        ) : (
          loading && <TypingIndicator />
        )}

        {error && (
          <div className="flex gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-500/20 text-sm">
              ⚠️
            </div>
            <div className="rounded-2xl rounded-tl-sm border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm leading-relaxed text-red-200">
              {error}
            </div>
          </div>
        )}

        {/* Suggested-action chips under the latest tutor message */}
        {!loading && suggestedActions.length > 0 && (
          <div className="flex flex-wrap gap-2 pl-11">
            {suggestedActions.map((action) => (
              <button
                key={action}
                onClick={() => void send(action)}
                className="rounded-full border border-lab-border bg-lab-bg px-3 py-1.5 text-xs text-indigo-300 transition-colors hover:border-lab-accent hover:text-white"
              >
                {action}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t border-lab-border p-4">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            placeholder={
              loading ? "Building…" : "Describe what you want to build…"
            }
            className="flex-1 rounded-lg border border-lab-border bg-lab-bg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-lab-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
          {loading ? (
            <button
              type="button"
              onClick={handleStop}
              aria-label="Stop"
              title="Stop"
              className="flex items-center gap-1.5 rounded-lg bg-red-500/90 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500"
            >
              <span aria-hidden>■</span> Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={input.trim() === ""}
              className="rounded-lg bg-lab-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-lab-border disabled:text-gray-500"
            >
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function TutorBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-lab-accent text-sm">
        🤖
      </div>
      <div className="rounded-2xl rounded-tl-sm bg-lab-bg px-4 py-3 text-sm leading-relaxed text-gray-200">
        {text}
      </div>
    </div>
  );
}

/** A quiet, client-only aside ("Stopped.") — never sent to the tutor as history. */
function NoteLine({ text }: { text: string }) {
  return (
    <div className="flex justify-center">
      <span className="rounded-full bg-lab-bg px-3 py-1 text-xs italic text-gray-500">
        {text}
      </span>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end gap-3">
      <div className="rounded-2xl rounded-tr-sm bg-lab-accent px-4 py-3 text-sm leading-relaxed text-white">
        {text}
      </div>
    </div>
  );
}

function StatusBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-lab-accent text-sm">
        🤖
      </div>
      <div className="animate-pulse rounded-2xl rounded-tl-sm bg-lab-bg px-4 py-3 text-sm italic leading-relaxed text-indigo-200">
        {text}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-lab-accent text-sm">
        🤖
      </div>
      <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm bg-lab-bg px-4 py-3.5">
        <span className="h-2 w-2 animate-bounce rounded-full bg-gray-500 [animation-delay:-0.3s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-gray-500 [animation-delay:-0.15s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-gray-500" />
      </div>
    </div>
  );
}
