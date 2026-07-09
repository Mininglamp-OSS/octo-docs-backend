// Ambient module declarations for the OMML→MathML→LaTeX import libs that ship
// without their own TypeScript types. Kept DOM-global-free (this backend does
// not include the DOM lib); the returned element is treated structurally.

declare module 'omml2mathml' {
  /**
   * Convert a parsed OMML DOM (classic xmldom Document/Element) into a MathML
   * DOM element. Read the result's `.outerHTML` to serialise it.
   */
  const omml2mathml: (omml: unknown) => { outerHTML?: string } | null
  export default omml2mathml
}

declare module 'xmldom' {
  export class DOMParser {
    parseFromString(source: string, mimeType?: string): unknown
  }
  export class XMLSerializer {
    serializeToString(node: unknown): string
  }
}
