/// <reference types="vite/client" />

// VITE_APP_ENV is read in src/shared/env.ts (readAppEnv) so a signed, packaged
// build can still target staging Supabase/Stripe — see electron.vite.config.ts /
// package.json's build:mac:staging. Declared here (not renderer/env.d.ts) because
// src/shared is compiled under BOTH tsconfig.node.json and tsconfig.web.json.
interface ImportMetaEnv {
  readonly VITE_APP_ENV?: string
}
