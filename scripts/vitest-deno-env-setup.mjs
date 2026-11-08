// Edge functions read config via Deno.env at MODULE SCOPE, so merely importing
// one throws "Deno is not defined" under Node -- and it throws during
// collection, so the suite reports 0 tests rather than a failure naming the
// cause. Tests that care about a specific value set it through this same map
// (see slack.test.ts); everything else just needs the import not to explode.
const env = new Map(Object.entries(process.env))
// Real Slack creds from secrets.env + unset SLACK_ENV_TAG = test runs post fake [prod] alerts.
for (const k of ['SLACK_BOT_TOKEN', 'SLACK_WEBHOOK_URL', 'SLACK_ADS_WEBHOOK_URL']) env.delete(k)

globalThis.Deno = {
  env: {
    get: (k) => env.get(k),
    set: (k, v) => env.set(k, String(v)),
    delete: (k) => env.delete(k),
    has: (k) => env.has(k),
    toObject: () => Object.fromEntries(env)
  },
  // Function entrypoints call Deno.serve at MODULE SCOPE, so importing one to
  // test its exported handlers would otherwise throw here too. No-op: tests
  // call the handlers directly, never through a listening server.
  serve: () => ({ finished: Promise.resolve(), shutdown: () => {} })
}
