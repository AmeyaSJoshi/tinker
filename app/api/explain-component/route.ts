import { NextResponse } from "next/server";
import { callExplainer, LlmError } from "@/lib/llm";
import { buildComponentExplainPrompt } from "@/lib/tutorPrompt";

// The active model can change mid-session; never cache a stale explanation route.
export const dynamic = "force-dynamic";

interface ExplainComponentBody {
  assetName: string;
  componentName: string;
}

interface ExplainComponentResponse {
  explanation: string;
}

function fallbackExplanation(componentName: string): string {
  return `I had trouble putting together an explanation for the ${componentName} just now — try clicking it again in a moment.`;
}

/**
 * Lightweight, plain-text explanation for ONE clicked submesh of a base GLB
 * model (see Task 1 in the Phase 3.2B spec). Never touches the tutor JSON
 * schema — a failure here degrades to a friendly inline message, never a crash.
 */
export async function POST(request: Request) {
  let body: ExplainComponentBody;
  try {
    body = (await request.json()) as ExplainComponentBody;
  } catch {
    return NextResponse.json<ExplainComponentResponse>(
      { explanation: "" },
      { status: 400 },
    );
  }

  const assetName = (body?.assetName ?? "").trim();
  const componentName = (body?.componentName ?? "").trim();
  if (!assetName || !componentName) {
    return NextResponse.json<ExplainComponentResponse>(
      { explanation: "" },
      { status: 400 },
    );
  }

  try {
    const explanation = (
      await callExplainer(
        buildComponentExplainPrompt(assetName, componentName),
        request.signal,
      )
    ).trim();
    return NextResponse.json<ExplainComponentResponse>({ explanation });
  } catch (err) {
    if (err instanceof LlmError && err.reason === "aborted") {
      return NextResponse.json<ExplainComponentResponse>({ explanation: "" });
    }
    console.error(`[explain-component] generation failed for "${componentName}":`, err);
    return NextResponse.json<ExplainComponentResponse>({
      explanation: fallbackExplanation(componentName),
    });
  }
}
