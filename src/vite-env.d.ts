/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO?: string;
  /** Unset/off by default. See `src/lib/flags.ts`. */
  readonly VITE_SINGLE_OCCURRENCE_GUARD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
