# BuildLab — AI Learning-by-Building Tutor

## What this is
A hackathon project (AI for Education Hackathon @ Stanford). A web app where a learner tells an AI tutor what they want to build (e.g. "a spaceship"), and a 3D model appears in the viewport. The tutor then guides them through upgrades ("make it survive re-entry"), adding parts to the model and explaining the science/engineering behind each part. Clicking a part shows its explanation. The system remembers the learner across sessions via EverOS.

## Stack
- Next.js 14+ (App Router) + React + TypeScript
- Tailwind CSS
- three.js via @react-three/fiber + @react-three/drei
- LLM: Google Gemini API (`gemini-2.5-flash`) — free tier, key in `GEMINI_API_KEY` env var
- Memory: EverOS (integration in Phase 4)
- Deploy target: Vercel

## Architecture
- `app/page.tsx` — split layout: chat panel (left, ~35%), 3D canvas (right, ~65%)
- `app/api/tutor/route.ts` — server route that calls Gemini, returns a validated parts manifest
- `components/ChatPanel.tsx` — message list + input + suggested-action chips
- `components/Viewport.tsx` — R3F canvas, renders parts from scene state
- `components/PartMesh.tsx` — renders one part from the schema, handles click → explanation card
- `lib/schema.ts` — Zod schemas for the parts manifest (single source of truth)
- `lib/sceneStore.ts` — Zustand store: current parts, chat history, concepts learned

## THE PARTS MANIFEST (core contract — never deviate)
Gemini must ONLY return JSON matching this schema. All 3D content is built from primitives. NEVER use external 3D assets, GLTF files, or model URLs.

```json
{
  "action": "create_base" | "add_parts" | "modify_parts" | "explain",
  "reply": "Conversational tutor message shown in chat",
  "parts": [
    {
      "id": "unique_snake_case_id",
      "shape": "box" | "sphere" | "cylinder" | "cone" | "torus" | "capsule",
      "dimensions": { "width": 1, "height": 1, "depth": 1, "radius": 1, "radiusTop": 1, "radiusBottom": 1 },
      "position": [0, 0, 0],
      "rotation": [0, 0, 0],
      "color": "#hex",
      "name": "Human-readable part name",
      "explanation": "2-4 sentence explanation of what this part does and the science behind it, written for a curious learner",
      "concepts": ["concept tag", "concept tag"]
    }
  ],
  "removedPartIds": [],
  "followUpQuestion": "One question nudging the learner's next step",
  "suggestedActions": ["Add landing gear", "Explain the heat shield more"]
}
```

Rules for the manifest:
- Only include dimension keys relevant to the shape
- `add_parts` merges into the scene; `create_base` replaces it; `modify_parts` replaces parts whose ids match
- Every part MUST have a real explanation with actual science — no filler
- Validate all Gemini responses with Zod before touching scene state; on validation failure, retry once with the error appended to the prompt, then show a friendly error in chat

## Gemini call conventions
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`
- Always set `generationConfig.responseMimeType: "application/json"`
- System prompt lives in `lib/tutorPrompt.ts` — includes the schema, primitive-composition tips (e.g. a rocket = cylinder body + cone nose + cone fins), and pedagogy rules (explain, then ask; never dump everything at once)
- Send full chat history + current scene manifest with every request (Gemini is stateless)
- API key is server-side only. Never expose it to the client.

## Coding conventions
- TypeScript strict mode; no `any`
- Small components; logic in `lib/`, presentation in `components/`
- Work in small chunks — one feature per session, verify in browser before moving on
- After each phase: run `npm run build` to confirm it compiles clean

## Phases (build in order, don't skip ahead)
1. Scaffold + static hardcoded spaceship rendering in R3F (proves the schema → mesh pipeline)
2. Chat → Gemini → manifest → live scene updates
3. Incremental parts, click-to-explain cards, assembly animations
4. EverOS memory integration (learner history, concepts covered)
5. Polish: suggested-action chips, "concepts learned" sidebar, quiz mode

## Demo constraints
- Must work reliably for: spaceship, volcano, human heart (rehearsed demo paths)
- Must degrade gracefully if Gemini returns bad JSON (never crash the scene)
