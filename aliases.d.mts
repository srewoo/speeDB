/**
 * Types for `aliases.mjs`.
 *
 * The alias table is plain JS because three consumers load it outside any
 * TypeScript pipeline — the two bench scripts and `check-cycles.mjs` all run
 * under bare `node`. A `.d.ts` beside it keeps the Vite configs, which are
 * typechecked, from falling back to `any`.
 */
export declare const CORE_SRC: string
export declare const EXTENSION_SRC: string
export declare const aliases: { find: RegExp; replacement: string }[]
