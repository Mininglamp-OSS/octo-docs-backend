/**
 * @octo/whiteboard-schema — frozen shared whiteboard schema package (XIN-16 §3).
 *
 * Single import surface for the three consumers that MUST share one definition:
 *   - front-end Excalidraw binding (XIN-25) — local normalize + key build/parse;
 *   - back-end authoritative repair (src/whiteboard/repair.ts);
 *   - back-end Agent conversion path (Element <-> Y.Map).
 *
 * Keep this package free of Yjs and backend imports so the front-end can use it
 * verbatim. Yjs adapters live in src/whiteboard/ydoc.ts (backend-only).
 */
export * from './constants.js'
export * from './types.js'
export * from './normalize.js'
export * from './name.js'
