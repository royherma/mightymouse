import {
  INFRA_AGENTS_LINE,
  INFRA_RECORD_PATH,
  infraKind,
  infraProvider,
  type AppKind,
  type BusinessType,
  type InfraKind,
  type InfraProvider,
  type InfraRecord
} from './infra'
import { keyProvider } from './key-providers'

export type KitId = 'website' | 'store' | 'web-app' | 'ios-app' | 'chrome-extension' | 'api'

interface KitServiceDef {
  kind: string
  provider: string
  label?: string
  keys?: string[]
}

export interface KitShip {
  label: string
  detail: string
  keys: string[]
  prompt: string
}

interface KitDef {
  id: KitId
  label: string
  hint: string
  appKind: AppKind
  repoName: string
  starter: string
  services: KitServiceDef[]
  ship: KitShip
  scaffold: string
}

export interface KitService {
  kind: InfraKind
  provider: InfraProvider
  label: string
  keys: string[]
}

export interface BuilderKit extends Omit<KitDef, 'services'> {
  services: KitService[]
}

const CLOUDFLARE_KEYS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']

const NO_KEYS_IN_CODE =
  'Never put a key value in code; read it from an environment variable and list every variable in .env.example.'

const SCAFFOLD_RULES = [
  'Write the files by hand. Do not run an installer or a scaffolding CLI, and do not run npm install.',
  `Add a CLAUDE.md containing exactly this line: ${INFRA_AGENTS_LINE}`,
  `Do not create ${INFRA_RECORD_PATH}; it is added for you.`,
  'Add a README.md with what this is, how to run it, and the one command that ships it. Add a .gitignore that ignores .env and node_modules.',
  NO_KEYS_IN_CODE,
  'Keep it small: something that works and looks good on first run, not a framework tour.'
].join('\n')

const KIT_DEFS: KitDef[] = [
  {
    id: 'website',
    label: 'Website',
    hint: 'A landing page, portfolio or blog',
    appKind: 'web',
    repoName: 'my-website',
    starter: 'Plain HTML and CSS, no build step',
    services: [
      { kind: 'hosting', provider: 'cloudflare', label: 'Hosting (Cloudflare Pages)', keys: CLOUDFLARE_KEYS },
      { kind: 'web_analytics', provider: 'cf_web_analytics', keys: CLOUDFLARE_KEYS },
      { kind: 'email', provider: 'resend', label: 'Contact form email' }
    ],
    ship: {
      label: 'Put it live',
      detail: 'Deploys to Cloudflare Pages and gives you a live web address.',
      keys: CLOUDFLARE_KEYS,
      prompt: [
        'Ship this website to Cloudflare Pages as a live URL.',
        'Add a wrangler.jsonc for Pages that serves this folder, and a GitHub Actions workflow that deploys on every push to main with `wrangler pages deploy`.',
        'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are in your environment: run the first deploy now and print the live URL as the last line of your answer.',
        'If a step needs me (a dashboard click, a GitHub secret), stop and tell me exactly that step as one line.',
        NO_KEYS_IN_CODE
      ].join('\n')
    },
    scaffold: [
      'Create a single-page website starter in this empty repo: index.html, styles.css, a favicon.svg, and a 404.html.',
      'Sections: a hero with a headline and one button, three benefits, a contact form (name, email, message) that posts to /api/contact and shows a thank-you message, and a footer with a privacy link.',
      'Use semantic HTML, a clean responsive layout with system fonts, and dark-mode support through prefers-color-scheme. No JavaScript frameworks. Placeholder copy must read like real copy, not lorem ipsum.',
      'The contact form has no backend yet; leave /api/contact for the email step.',
      SCAFFOLD_RULES
    ].join('\n')
  },
  {
    id: 'store',
    label: 'Online store',
    hint: 'Sell products with Shopify',
    appKind: 'web',
    repoName: 'my-store',
    starter: 'A Shopify theme (Liquid)',
    services: [{ kind: 'hosting', provider: 'shopify_theme', label: 'Store (Shopify)', keys: ['SHOPIFY_ACCESS_TOKEN'] }],
    ship: {
      label: 'Put it in my store',
      detail: 'Uploads the theme to your Shopify store as a draft you can preview, then publish.',
      keys: ['SHOPIFY_ACCESS_TOKEN'],
      prompt: [
        'Ship this Shopify theme to my store as an unpublished theme I can preview.',
        'SHOPIFY_ACCESS_TOKEN is in your environment (a Theme Access password or an admin token with theme access). If SHOPIFY_STORE is not set, stop and ask me for my store address (name.myshopify.com) as one line.',
        'Run `npx @shopify/cli theme push --unpublished --store "$SHOPIFY_STORE" --password "$SHOPIFY_ACCESS_TOKEN"` and print the preview URL as the last line of your answer. Also add a GitHub Actions workflow that pushes on every push to main.',
        NO_KEYS_IN_CODE
      ].join('\n')
    },
    scaffold: [
      'Create a Shopify Online Store 2.0 theme starter in this empty repo, following the standard theme folder layout (layout/theme.liquid, templates/*.json, sections, snippets, assets, config/settings_schema.json, locales/en.default.json).',
      'Pages: a home page with a hero and a featured-products section, a product page with images, price, variant picker and add-to-cart, a collection grid, a cart page, and a 404. Every section is editable in the Shopify theme editor through its schema.',
      'Clean, fast, responsive CSS with system fonts; no JavaScript framework. Placeholder copy must read like real copy, not lorem ipsum.',
      SCAFFOLD_RULES
    ].join('\n')
  },
  {
    id: 'web-app',
    label: 'Web app',
    hint: 'Sign-in, a database and payments',
    appKind: 'web',
    repoName: 'my-web-app',
    starter: 'Next.js with TypeScript',
    services: [
      { kind: 'database', provider: 'supabase', keys: ['SUPABASE_URL', 'SUPABASE_ANON_KEY'] },
      { kind: 'auth', provider: 'supabase_auth', label: 'Sign-in (Supabase)', keys: [] },
      { kind: 'payments', provider: 'stripe', keys: ['STRIPE_SECRET_KEY'] },
      { kind: 'email', provider: 'resend' },
      { kind: 'errors', provider: 'sentry', keys: ['SENTRY_DSN'] },
      { kind: 'product_analytics', provider: 'posthog' }
    ],
    ship: {
      label: 'Put it live',
      detail: 'Deploys to Vercel and gives you a live web address.',
      keys: ['VERCEL_TOKEN'],
      prompt: [
        'Ship this Next.js app to Vercel as a live URL.',
        'VERCEL_TOKEN is in your environment: link or create the Vercel project with the vercel CLI, deploy to production, and print the live URL as the last line of your answer. Do not commit the .vercel folder or the token.',
        'If a step needs me (a dashboard click, connecting a domain), stop and tell me exactly that step as one line.',
        NO_KEYS_IN_CODE
      ].join('\n')
    },
    scaffold: [
      'Create a Next.js (App Router, TypeScript) SaaS starter in this empty repo.',
      'Pages: a landing page, /login, /signup, and a signed-in /dashboard with a placeholder card. Add a /api/health route returning {"ok":true}.',
      'Clean responsive layout with a single globals.css, dark-mode support. Pin sensible dependency versions in package.json (next, react, react-dom, typescript, @types/*).',
      'Leave sign-in, the database, payments, email, error tracking and analytics for later steps; only stub the pages.',
      SCAFFOLD_RULES
    ].join('\n')
  },
  {
    id: 'ios-app',
    label: 'iPhone app',
    hint: 'Built in the cloud, no Mac needed',
    appKind: 'mobile',
    repoName: 'my-iphone-app',
    starter: 'Expo (React Native) with TypeScript',
    services: [
      { kind: 'database', provider: 'supabase', keys: ['SUPABASE_URL', 'SUPABASE_ANON_KEY'] },
      { kind: 'auth', provider: 'supabase_auth', label: 'Sign-in (Supabase)', keys: [] },
      { kind: 'payments', provider: 'revenuecat', label: 'Subscriptions (RevenueCat)', keys: ['REVENUECAT_API_KEY'] },
      { kind: 'errors', provider: 'sentry', keys: ['SENTRY_DSN'] },
      { kind: 'push', provider: 'expo_notifications', keys: [] }
    ],
    ship: {
      label: 'Send to TestFlight',
      detail:
        'Needs an Apple Developer account, $99 a year, paid to Apple. Expo builds it in the cloud with no Mac; its free plan covers 15 iPhone builds a month.',
      keys: ['EXPO_TOKEN'],
      prompt: [
        'Set this Expo app up to build and send to TestFlight from the cloud with EAS, no Mac.',
        'Add eas.json with a production profile (store distribution, auto-increment build number), fill app.json with a bundleIdentifier, and add a GitHub Actions workflow that runs `eas build --platform ios --profile production --non-interactive --auto-submit`.',
        'EXPO_TOKEN is in your environment. The Apple sign-in cannot be automated: finish by telling me, as a short numbered list, what I must do in my Apple Developer account (join the $99/year program, create the app in App Store Connect, create an App Store Connect API key for EAS).',
        NO_KEYS_IN_CODE
      ].join('\n')
    },
    scaffold: [
      'Create an Expo (React Native, TypeScript, Expo Router) iPhone app starter in this empty repo.',
      'Screens: a home tab, a sign-in screen and a settings tab, each with placeholder content that reads like real copy. Set app.json name and slug from the repo name, and ios.supportsTablet false.',
      'Pin sensible dependency versions in package.json (expo, expo-router, react-native, react, typescript, @types/react). Include a start script `expo start`.',
      'Leave the database, sign-in, subscriptions, error tracking and push for later steps.',
      SCAFFOLD_RULES
    ].join('\n')
  },
  {
    id: 'chrome-extension',
    label: 'Chrome extension',
    hint: 'A button in the browser bar',
    appKind: 'web',
    repoName: 'my-extension',
    starter: 'Vite with Manifest V3',
    services: [
      { kind: 'product_analytics', provider: 'posthog' },
      { kind: 'errors', provider: 'sentry', keys: ['SENTRY_DSN'] },
      { kind: 'payments', provider: 'stripe', label: 'Paid tier (Stripe)', keys: ['STRIPE_SECRET_KEY'] }
    ],
    ship: {
      label: 'Build the zip',
      detail: 'Makes the zip you upload to the Chrome Web Store. Google charges a one-time $5 developer sign-up.',
      keys: [],
      prompt: [
        'Prepare this Chrome extension to ship to the Chrome Web Store.',
        'Add an `npm run zip` script that builds and writes dist/extension.zip containing only the built extension, and a GitHub Actions workflow that runs it and uploads the zip as a build artifact on every push to main.',
        'Check manifest.json against Chrome Web Store rules: name, description, version, 16/48/128 icons, and only the permissions the code needs. Add a PRIVACY.md stating what data is collected.',
        'Finish by telling me, as a short numbered list, what I do on the Chrome Web Store dashboard to upload the zip.'
      ].join('\n')
    },
    scaffold: [
      'Create a Chrome extension starter (Manifest V3) built with Vite and TypeScript in this empty repo.',
      'It has a toolbar popup (a small, clean panel with a title and one button that does something visible on the current tab through a content script), a background service worker, and a manifest.json with the minimum permissions. Icons at 16, 48 and 128 px must be real PNG files generated by a small script you run.',
      'Pin sensible dependency versions in package.json (vite, typescript, @types/chrome). Scripts: `dev`, `build` (outputs dist/).',
      'Leave analytics, error tracking and payments for later steps.',
      SCAFFOLD_RULES
    ].join('\n')
  },
  {
    id: 'api',
    label: 'API or backend',
    hint: 'Endpoints other apps talk to',
    appKind: 'worker',
    repoName: 'my-api',
    starter: 'Cloudflare Worker with a D1 database',
    services: [
      { kind: 'database', provider: 'd1', label: 'Database (Cloudflare D1)', keys: CLOUDFLARE_KEYS },
      { kind: 'health', provider: 'health_route', label: 'Health check' },
      { kind: 'health', provider: 'betterstack_uptime', label: 'Uptime alert', keys: ['BETTERSTACK_API_TOKEN'] },
      { kind: 'logging', provider: 'cf_observability', keys: CLOUDFLARE_KEYS },
      { kind: 'errors', provider: 'sentry', keys: ['SENTRY_DSN'] }
    ],
    ship: {
      label: 'Deploy it',
      detail: 'Deploys to Cloudflare Workers and gives you a live address.',
      keys: CLOUDFLARE_KEYS,
      prompt: [
        'Ship this Worker to Cloudflare Workers as a live URL.',
        'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are in your environment: create the D1 database if the config needs one, apply migrations, run `wrangler deploy`, and print the live URL as the last line of your answer. Also add a GitHub Actions workflow that deploys on push to main.',
        'If a step needs me (a dashboard click, a GitHub secret), stop and tell me exactly that step as one line.',
        NO_KEYS_IN_CODE
      ].join('\n')
    },
    scaffold: [
      'Create a Cloudflare Worker API starter (TypeScript, wrangler.jsonc, D1 binding named DB) in this empty repo.',
      'Routes: GET /health returns {"ok":true}, and a small example resource (GET and POST /notes) backed by D1 with a migrations/0001_init.sql. Return JSON errors with correct status codes.',
      'Pin sensible dependency versions in package.json (wrangler, typescript, @cloudflare/workers-types). Scripts: `dev`, `deploy`.',
      'Turn on Workers Logs (observability enabled) in wrangler.jsonc. Leave uptime alerts and error tracking for later steps.',
      SCAFFOLD_RULES
    ].join('\n')
  }
]

function resolveService(def: KitServiceDef): KitService[] {
  const kind = infraKind(def.kind)
  const provider = infraProvider(def.kind, def.provider)
  if (!kind || !provider) return []
  const keys = def.keys ?? keyProvider(provider.keyProvider ?? '')?.envNames.slice(0, 1) ?? []
  return [{ kind, provider, label: def.label ?? kind.label, keys }]
}

export const BUILDER_KITS: BuilderKit[] = KIT_DEFS.map((def) => ({
  ...def,
  services: def.services.flatMap(resolveService)
}))

export function builderKit(id: string | null | undefined): BuilderKit | null {
  return BUILDER_KITS.find((k) => k.id === id) ?? null
}

const SHIP_KIT_FOR: Record<AppKind, KitId | null> = {
  web: 'web-app',
  mobile: 'ios-app',
  worker: 'api',
  desktop: null
}

export function shipFor(kit: BuilderKit | null, appKinds: AppKind[]): KitShip | null {
  if (kit) return kit.ship
  const id = appKinds.map((k) => SHIP_KIT_FOR[k]).find(Boolean)
  return builderKit(id)?.ship ?? null
}

export const KIT_BUSINESS: Record<KitId, BusinessType> = {
  website: 'landing',
  store: 'store',
  'web-app': 'saas',
  'ios-app': 'app',
  'chrome-extension': 'extension',
  api: 'devtool'
}

export function kitRecord(kit: BuilderKit): InfraRecord {
  return {
    checkedAt: new Date().toISOString(),
    appKinds: [kit.appKind],
    business: [KIT_BUSINESS[kit.id]],
    kit: kit.id,
    services: {},
    skip: []
  }
}
