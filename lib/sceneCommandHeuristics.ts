/**
 * Scene-command phrases ("make it smaller", "it's too dark", "make the
 * rocket red") describe adjusting the CURRENT scene via a sceneOp — never a
 * request to build a brand-new base model, and never just a question to
 * answer in prose. Shared by:
 *  - ChatPanel (client): so these don't get misrouted into a Poly Pizza asset
 *    search just because they contain "make".
 *  - The tutor route (server): so BUILD/EXPLAIN classification doesn't treat
 *    them as a question and answer with an inert explanation instead of an
 *    actual sceneOp.
 */
export const SCENE_COMMAND_RE =
  /\b(it'?s too (dark|small|big|large|tiny)|can'?t see (it|the whole|everything)|make it (smaller|bigger|larger|shorter|taller|visible|brighter|lighter|darker)|make (the \w+|it) (red|orange|yellow|green|blue|purple|pink|black|white|gray|grey|brown|#[0-9a-f]{3,8})|reset (the )?(view|camera))\b/i;
