// Tests in this directory import ESM `.mjs` helpers that have no type
// declarations. Tell TS to treat them as `any` rather than failing the
// build. The individual `// @ts-ignore` directives in each test file are
// belt-and-suspenders for editor diagnostics.
declare module '*.mjs'
