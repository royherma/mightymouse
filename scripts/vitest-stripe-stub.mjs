// Stands in for `npm:stripe@14` when vitest imports an edge function (see the
// alias in vitest.config.ts). Type-only in practice: the handlers under test
// never call the SDK — the real client is constructed inside Deno.serve, which
// vitest-deno-env-setup.mjs no-ops. Aliasing the real npm package instead would
// add a dependency solely to satisfy one import line.
export default class Stripe {}
