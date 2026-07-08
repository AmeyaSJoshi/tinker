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

const WELCOME =
  "What do you want to build today? Tell me something like “a spaceship” and I’ll bring it to life in 3D — then we’ll upgrade it together.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Words that signal a fresh build request rather than an edit/question. */
const CREATE_RE =
  /\b(build|make|create|design|construct|model|show me|give me|generate|render|i want|i'?d like)\b/i;

/**
 * Decide whether a message should first try to resolve to a realistic base
 * MODEL (via /api/resolve-asset). A clear "build/make" verb always qualifies;
 * so does the very first message when nothing exists yet, unless it's obviously
 * a question. Edits like "add a fin" on an existing scene do NOT.
 */
function looksLikeCreate(text: string, hasScene: boolean): boolean {
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
    /^(please\s+)?(can you\s+|could you\s+)?(i\s+(want|wanna|would like|'?d like)\s+(to\s+)?)?(build|make|create|design|show me|give me|draw|model|render|let'?s\s+(build|make|create)|add)\s+/,
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
  const loadBaseAsset = useSceneStore((s) => s.loadBaseAsset);
  const clearScene = useSceneStore((s) => s.clearScene);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A lively "finding you a realistic X…" line shown while a live fetch runs.
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  // Chips from the latest tutor turn; cleared while a request is in flight.
  const [suggestedActions, setSuggestedActions] = useState<string[]>([]);
  // Which model is answering — shown as a small badge for A/B visibility.
  const [modelLabel, setModelLabel] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Ask the server which brain is currently ACTIVE (never exposes the key). The
  // active model can change mid-session (auto-switch after repeated failures),
  // so we refresh this after every tutor turn as well as on mount.
  const refreshModelBadge = useCallback(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.model === "string") setModelLabel(d.model);
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
      addMessage({ role: "tutor", content: step.reply });
      setSuggestedActions(step.suggestedActions ?? []);
      // Small beat between steps so parts visibly assemble one stage at a time.
      await sleep(200);
    }
  }

  /** Try to resolve a build request to a realistic base MODEL. Null = use primitives. */
  async function resolveAsset(phrase: string): Promise<BaseAsset | null> {
    try {
      const res = await fetch("/api/resolve-asset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if ((data?.status === "library" || data?.status === "live") && data.asset) {
        return data.asset as BaseAsset;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Call the tutor for a primitives build/edit and apply the result. */
  async function runTutor(
    text: string,
    priorHistory: ChatMessage[],
    baseAssetId?: string,
  ) {
    const res = await fetch("/api/tutor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        history: priorHistory,
        currentParts: useSceneStore.getState().parts,
        baseAssetId,
      }),
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);

    const data = await res.json();
    const parsed = tutorResponseSchema.safeParse(data);
    if (!parsed.success) throw new Error("Malformed tutor response");

    const response: TutorResponse = parsed.data;
    applyManifest(response);
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

    try {
      if (looksLikeCreate(trimmed, hasScene)) {
        setLiveStatus(`🔍 Finding you a realistic ${coreNoun(trimmed)}…`);
        const asset = await resolveAsset(trimmed);
        setLiveStatus(null);
        if (asset) {
          loadBaseAsset(asset);
          addMessage({ role: "tutor", content: asset.intro });
          setSuggestedActions(baseAssetSuggestions(asset));
          return;
        }
        // No realistic model — build it from primitives instead (no base).
        await runTutor(trimmed, priorHistory);
        return;
      }

      // Edit / question on the existing scene. Carry the base asset id (if any)
      // so the tutor gets its anchors and can attach parts precisely.
      await runTutor(trimmed, priorHistory, before.baseAsset?.id);
    } catch (err) {
      console.error(err);
      setError(
        "I couldn’t reach the tutor just now. Check your connection and try again.",
      );
    } finally {
      setLiveStatus(null);
      setLoading(false);
      // The active model may have auto-switched this turn — keep the badge honest.
      refreshModelBadge();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void send(input);
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
          {modelLabel && (
            <span
              className="flex items-center gap-1 rounded-full border border-lab-border bg-lab-bg px-2 py-0.5 text-[11px] text-gray-400"
              title="Model currently answering"
            >
              🧠 {modelLabel}
            </span>
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

        {messages.map((m, i) =>
          m.role === "tutor" ? (
            <TutorBubble key={i} text={m.content} />
          ) : (
            <UserBubble key={i} text={m.content} />
          ),
        )}

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
          <button
            type="submit"
            disabled={loading || input.trim() === ""}
            className="rounded-lg bg-lab-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-lab-border disabled:text-gray-500"
          >
            Send
          </button>
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
