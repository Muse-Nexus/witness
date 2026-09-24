/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" swaps the core API for the in-memory mock with synthetic data. */
  readonly VITE_MOCK_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
