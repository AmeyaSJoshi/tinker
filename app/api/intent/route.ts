import { NextResponse } from "next/server";
import { classifyMessage, intentResultSchema, type IntentResult } from "@/lib/intentRouter";
import { LlmError } from "@/lib/llm";
import type { ChatMessage } from "@/lib/schema";

// The active model can change mid-session; classification must reflect that live.
export const dynamic = "force-dynamic";

interface IntentRequestBody {
  message: string;
  /** Last couple of chat turns, oldest first — just enough for context. */
  history?: ChatMessage[];
  baseAssetName?: string | null;
}

const NEUTRAL_FALLBACK: IntentResult = {
  intent: "build_new",
  targetObject: null,
  isCompound: false,
};

export async function POST(request: Request) {
  let body: IntentRequestBody;
  try {
    body = (await request.json()) as IntentRequestBody;
  } catch {
    return NextResponse.json(NEUTRAL_FALLBACK);
  }

  const message = (body?.message ?? "").trim();
  if (message === "") {
    return NextResponse.json(NEUTRAL_FALLBACK);
  }

  const history = Array.isArray(body?.history) ? body.history : [];
  const baseAssetName =
    typeof body?.baseAssetName === "string" && body.baseAssetName.trim() !== ""
      ? body.baseAssetName
      : null;

  try {
    const result = await classifyMessage(
      message,
      { recentHistory: history, baseAssetName },
      request.signal,
    );
    return NextResponse.json(intentResultSchema.parse(result));
  } catch (err) {
    if (err instanceof LlmError && err.reason === "aborted") {
      return NextResponse.json(NEUTRAL_FALLBACK);
    }
    // classifyMessage already has its own keyword-heuristic fallback and
    // should not throw in practice; this is a last-ditch safety net.
    console.error("[api/intent] classification failed unexpectedly:", err);
    return NextResponse.json(NEUTRAL_FALLBACK);
  }
}
