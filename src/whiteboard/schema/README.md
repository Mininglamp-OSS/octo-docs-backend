# `@octo/whiteboard-schema` (frozen shared package)

> **Canonical source:** the package now lives in its own frozen, versioned repo
> — `boris-clark/octo-whiteboard-schema` @ **v0.2.0** (`WB_SCHEMA_VERSION = 2`),
> so the front-end (XIN-25) can import it directly. The files in this directory
> are a **byte-identical mirror** kept here so the back-end builds without a
> cross-repo dependency; they MUST stay in lockstep with the published package
> (bump together, never edit one side only). Once the package's permanent home
> is ratified, the back-end will depend on it directly instead of mirroring.

This directory is the source of the **frozen shared whiteboard schema package**
defined by the XIN-16 single-authority contract (§3). It is the whiteboard
analogue of `@octo/docs-schema` (which lives in this repo as the local stand-in
`src/schema/index.ts`).

## Who shares it

The **same source** is imported by all three consumers, so none of them
hard-codes field names or normalize rules:

1. **Front-end Excalidraw binding (XIN-25)** — local, render-time defensive
   `normalizeElement` + key build/parse. The front-end vendors this directory
   verbatim (same files, same `WB_SCHEMA_VERSION`).
2. **Back-end authoritative repair** — `src/whiteboard/repair.ts`.
3. **Back-end Agent conversion path** — Element ↔ Y.Map (`src/whiteboard/ydoc.ts`).

The only difference between front-end and back-end is **who may write the
normalized result back** (the back-end repair is the single authoritative
writer, §4); the rule set itself is identical.

## Freeze / versioning policy (§3.2)

- Changing the element layout or the `normalizeElement` rule set **requires
  bumping `WB_SCHEMA_VERSION`**, released to front-end and back-end together, so
  a gray-release window never has one side on new rules and the other on old.
- `WB_SCHEMA_VERSION` is **isolated** from the ProseMirror `SCHEMA_VERSION = 15`
  (§6 / XIN-14 §8.2 risk 6). Whiteboard `doc_version.schema_version` gates on
  `WB_SCHEMA_VERSION`, never on the PM version.
- The package is **Yjs-free and backend-free** on purpose. The Y.Map adapters
  that touch Yjs live in `src/whiteboard/ydoc.ts` (backend only), outside the
  shared source.

## Exports

| Export | Purpose |
|---|---|
| `ELEMENTS_FIELD` (`'elements'`) | top-level elements `Y.Map` field name (§1) |
| `FILES_FIELD` (`'files'`) | top-level files `Y.Map` field name (§2) |
| `WB_SCHEMA_VERSION` | whiteboard schema version, isolated from PM 15 (§6) |
| `WB_ELEMENT_TYPES` | Excalidraw element `type` whitelist |
| `normalizeElement(el, ctx?)` | shared pure normalize rule set (§1/§4/§6) |
| `elementSupersedes(cur, inc)` | CAS arbitration (version / versionNonce) (§1.1) |
| `buildWhiteboardName` / `parseWhiteboardName` | `octo:{space}:{folder}:wb:{board}` |
| `REPAIR_ORIGIN` / `REPAIR_CLIENT_ID` | repair transaction origin / fixed client id |
