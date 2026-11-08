export type AppKind = 'web' | 'mobile' | 'desktop' | 'worker'

export const APP_KIND_LABELS: Record<AppKind, string> = {
  web: 'Website or web app',
  mobile: 'Phone app',
  desktop: 'Desktop app',
  worker: 'API or backend'
}

export const BUSINESS_TYPES = [
  'store',
  'saas',
  'app',
  'marketplace',
  'extension',
  'devtool',
  'content',
  'landing',
  'internal'
] as const
export type BusinessType = (typeof BUSINESS_TYPES)[number]

export const BUSINESS_LABELS: Record<BusinessType, { label: string; hint: string }> = {
  store: { label: 'Online store', hint: 'Sells products with a cart and checkout' },
  saas: { label: 'Subscription app', hint: 'People sign in and pay monthly or yearly' },
  app: { label: 'Downloadable app', hint: 'A phone or desktop app from a store or a download' },
  marketplace: { label: 'Marketplace', hint: 'Connects buyers and sellers and pays sellers out' },
  extension: { label: 'Browser extension', hint: 'Installed from the Chrome Web Store' },
  devtool: { label: 'Developer tool', hint: 'An API, library or command-line tool' },
  content: { label: 'Content site', hint: 'A blog, docs or newsletter people find by search' },
  landing: { label: 'Landing page', hint: 'One site whose job is sign-ups or leads' },
  internal: { label: 'Internal tool', hint: 'A dashboard or tool for your own team' }
}

export type TagField = 'appKinds' | 'business'

export function cleanTags(field: TagField, values: unknown): AppKind[] | BusinessType[] {
  const allowed: readonly string[] =
    field === 'business' ? BUSINESS_TYPES : Object.keys(APP_KIND_LABELS)
  const list = Array.isArray(values) ? values : []
  return allowed.filter((id) => list.includes(id)) as AppKind[] | BusinessType[]
}

export const GOAL_LIVE = 'live'
export const BRIEF_LINE_MAX = 80

export interface ProjectGoal {
  metric: string
  target?: number
  by?: string
}

export interface ProjectBrief {
  what?: string
  audience?: string
  niche?: string
  goal?: ProjectGoal
}

function briefLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.replace(/\s+/g, ' ').trim().slice(0, BRIEF_LINE_MAX) || undefined
}

function cleanGoal(value: unknown): ProjectGoal | undefined {
  const goal = value as Partial<ProjectGoal> | null
  if (!goal || typeof goal.metric !== 'string' || !/^[a-z][a-z0-9.-]{0,59}$/.test(goal.metric))
    return undefined
  const target = typeof goal.target === 'number' && Number.isFinite(goal.target) ? goal.target : undefined
  const by = typeof goal.by === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(goal.by) ? goal.by : undefined
  return {
    metric: goal.metric,
    ...(target !== undefined ? { target } : {}),
    ...(by ? { by } : {})
  }
}

export function cleanBrief(value: unknown): ProjectBrief | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const what = briefLine(raw.what)
  const audience = briefLine(raw.audience)
  const niche = briefLine(raw.niche)
  const goal = cleanGoal(raw.goal)
  if (!what && !audience && !niche && !goal) return undefined
  return {
    ...(what ? { what } : {}),
    ...(audience ? { audience } : {}),
    ...(niche ? { niche } : {}),
    ...(goal ? { goal } : {})
  }
}

export function briefSentence(brief: ProjectBrief | undefined): string {
  if (!brief?.what && !brief?.audience) return ''
  if (!brief.what) return `It is for ${brief.audience}.`
  return `${brief.what}${brief.audience ? `, for ${brief.audience}` : ''}.`
}

export type InfraGroup = 'watch' | 'users' | 'runs' | 'safety'

export const INFRA_GROUP_LABELS: Record<InfraGroup, string> = {
  watch: 'Watch',
  users: 'Users and money',
  runs: 'Runs on',
  safety: 'Safety'
}

export interface InfraProvider {
  id: string
  label: string
  keyProvider?: string
  noKey?: boolean
  site?: string
  deps?: string[]
  code?: string[]
  codeIn?: string[]
  files?: string[]
  fallback?: boolean
  offer?: string
  onlyFor?: AppKind[]
  covers?: string[]
}

export interface InfraKind {
  id: string
  label: string
  ask?: string
  group: InfraGroup
  missing: string
  appliesTo: AppKind[]
  recommend?: string
  optional?: boolean
  providers: InfraProvider[]
}

export interface InfraEntry {
  provider: string
  label?: string
  foundIn?: string
  key?: string
  keyGuessed?: boolean
  manual?: boolean
}

export interface InfraRecord {
  checkedAt: string
  appKinds: AppKind[]
  business?: BusinessType[]
  brief?: ProjectBrief
  pinned?: TagField[]
  kit?: string
  services: Record<string, InfraEntry[]>
  skip: string[]
  want?: string[]
  setups?: Record<string, InfraSetup>
  environments?: InfraEnvironment[]
  surfaces?: InfraSurface[]
  names?: string[]
}

export interface InfraSurface {
  name: string
  paths: string[]
  kind?: AppKind
  manual?: boolean
}

export interface EnvAccount {
  provider: 'supabase' | 'stripe'
  id: string
  foundIn: string
}

export interface InfraEnvironment {
  name: string
  foundIn: string[]
  urls: string[]
  accounts: EnvAccount[]
}

export interface InfraSetup {
  provider: string
  startedAt: string
  pane?: string
  had?: string[]
}

export type SetupState = 'starting' | 'working' | 'waiting' | 'stopped'

export interface ProjectInfra {
  projectId: string
  repoFolder?: string
  record: InfraRecord | null
  error?: string
  live?: Record<string, SetupState>
}

export interface PublishedSite {
  name: string
  url: string
  publishedAt: string
  files: number
  folder: string
}

export interface SiteState {
  site: PublishedSite | null
  suggested: string
  pageFolder: string | null
  error?: string
  planRequired?: boolean
}

export interface SiteProgress {
  projectId: string
  step: 'checking' | 'sending' | 'finishing'
  sent: number
  total: number
}

export const SITE_BUILD_PROMPT = [
  'I want to put this project online as a simple website.',
  'Make it produce ready-to-serve files with an index.html at the top of one of these folders: dist, build, out or public. Use the build this project already has if there is one; if there is no website here yet, make a clean one-page site about this project in dist.',
  'It has to work as plain files: no server code, and links that work from any address.',
  'Run the build and check index.html exists, then tell me in one line which folder it is in.'
].join('\n')

export const SITE_RECORD_PATH = '.mightymouse/site.json'
export const INFRA_RECORD_PATH = '.mightymouse/stack.json'
export const INFRA_AGENTS_LINE = `Services this project uses: see ${INFRA_RECORD_PATH}`

const ALL: AppKind[] = ['web', 'mobile', 'desktop', 'worker']

const MONEY_SOURCES: InfraProvider[] = [
  {
    id: 'stripe',
    label: 'Stripe',
    keyProvider: 'stripe',
    deps: ['stripe', '@stripe/'],
    code: ['api\\.stripe\\.com', 'js\\.stripe\\.com', 'buy\\.stripe\\.com', 'new Stripe\\(', 'loadStripe\\(']
  },
  {
    id: 'revenuecat',
    label: 'RevenueCat',
    keyProvider: 'revenuecat',
    deps: ['react-native-purchases', '@revenuecat/'],
    code: ['Purchases\\.configure']
  },
  {
    id: 'lemonsqueezy',
    label: 'Lemon Squeezy',
    site: 'lemonsqueezy.com',
    deps: ['@lemonsqueezy/'],
    code: ['lemonsqueezy\\.com']
  },
  { id: 'paddle', label: 'Paddle', site: 'paddle.com', deps: ['@paddle/'] },
  {
    id: 'shopify',
    label: 'Shopify',
    keyProvider: 'shopify',
    deps: ['@shopify/cli', '@shopify/hydrogen', '@shopify/shopify-api'],
    code: ['myshopify\\.com']
  }
]

export const INFRA_KINDS: InfraKind[] = [
  {
    id: 'product_analytics',
    label: 'Product analytics',
    ask: 'Do you want to see what people do in it?',
    group: 'watch',
    missing: "You can't see what people do in the app",
    appliesTo: ['web', 'mobile', 'desktop'],
    recommend: 'posthog',
    providers: [
      {
        id: 'posthog',
        label: 'PostHog',
        keyProvider: 'posthog',
        deps: ['posthog-js', 'posthog-node', 'posthog-react-native', 'posthog-js-lite'],
        code: ['posthog\\.init\\(', 'new PostHog\\(', 'PostHogProvider', 'i\\.posthog\\.com']
      },
      {
        id: 'amplitude',
        label: 'Amplitude',
        keyProvider: 'amplitude',
        deps: ['@amplitude/'],
        code: ['amplitude\\.init\\(', '\\binit\\(\\s*AMPLITUDE', 'api2?\\.amplitude\\.com']
      },
      {
        id: 'mixpanel',
        label: 'Mixpanel',
        keyProvider: 'mixpanel',
        deps: ['mixpanel-browser', 'mixpanel', 'mixpanel-react-native'],
        code: ['mixpanel\\.init\\(']
      },
      {
        id: 'segment',
        label: 'Segment',
        site: 'segment.com',
        deps: ['@segment/'],
        code: ['analytics\\.load\\(']
      },
      {
        id: 'firebase_analytics',
        label: 'Firebase Analytics',
        keyProvider: 'firebase',
        deps: ['@react-native-firebase/analytics'],
        code: ['getAnalytics\\(']
      },
      { id: 'aptabase', label: 'Aptabase', site: 'aptabase.com', deps: ['@aptabase/'] },
      {
        id: 'telemetrydeck',
        label: 'TelemetryDeck',
        site: 'telemetrydeck.com',
        code: ['TelemetryDeck\\.initialize']
      },
      {
        id: 'clarity',
        label: 'Microsoft Clarity',
        keyProvider: 'clarity',
        noKey: true,
        deps: ['@microsoft/clarity'],
        code: ['clarity\\.ms/tag', 'CLARITY_PROJECT_ID']
      }
    ]
  },
  {
    id: 'web_analytics',
    label: 'Site visits',
    group: 'watch',
    missing: "You can't see who visits the site",
    appliesTo: ['web'],
    recommend: 'cf_web_analytics',
    providers: [
      {
        id: 'cf_web_analytics',
        label: 'Cloudflare Web Analytics',
        keyProvider: 'cloudflare',
        noKey: true,
        code: ['static\\.cloudflareinsights\\.com', 'cf-beacon']
      },
      {
        id: 'plausible',
        label: 'Plausible',
        site: 'plausible.io',
        deps: ['plausible-tracker'],
        code: ['plausible\\.io/js']
      },
      {
        id: 'ga4',
        label: 'Google Analytics',
        keyProvider: 'google-analytics',
        noKey: true,
        deps: ['react-ga4', '@next/third-parties'],
        code: ['googletagmanager\\.com/gtag', 'gtag\\(\\s*[\'"]config']
      },
      {
        id: 'vercel_analytics',
        label: 'Vercel Analytics',
        keyProvider: 'vercel',
        noKey: true,
        deps: ['@vercel/analytics']
      },
      {
        id: 'umami',
        label: 'Umami',
        site: 'umami.is',
        code: ['data-website-id=.*umami', 'umami\\.is/script']
      },
      {
        id: 'fathom',
        label: 'Fathom',
        site: 'usefathom.com',
        deps: ['fathom-client'],
        code: ['cdn\\.usefathom\\.com']
      },
      {
        id: 'own_visits',
        label: 'Own visit tracking',
        code: ['INSERT INTO\\s+(events|page_?views|visits|analytics_events)\\b[^;]{0,200}\\bpath\\b'],
        fallback: true
      }
    ]
  },
  {
    id: 'errors',
    label: 'Error alerts',
    group: 'watch',
    missing: "When it breaks for someone, you don't hear about it",
    appliesTo: ALL,
    recommend: 'sentry',
    providers: [
      {
        id: 'sentry',
        label: 'Sentry',
        keyProvider: 'sentry',
        deps: ['@sentry/', 'sentry-expo'],
        code: [
          'Sentry\\.init\\(',
          'withSentry\\(',
          'SentrySDK\\.start',
          '\\.ingest(\\.[a-z]+)?\\.sentry\\.io/',
          'x-sentry-envelope'
        ]
      },
      {
        id: 'crashlytics',
        label: 'Crashlytics',
        keyProvider: 'firebase',
        deps: ['@react-native-firebase/crashlytics'],
        code: ['FirebaseCrashlytics', 'crashlytics\\(\\)']
      },
      {
        id: 'bugsnag',
        label: 'Bugsnag',
        site: 'bugsnag.com',
        deps: ['@bugsnag/'],
        code: ['Bugsnag\\.start\\(']
      },
      { id: 'rollbar', label: 'Rollbar', site: 'rollbar.com', deps: ['rollbar'] },
      {
        id: 'electron_crash',
        label: 'Electron crash reports',
        site: 'electronjs.org',
        code: ['crashReporter\\.start\\(']
      },
      {
        id: 'logrocket',
        label: 'LogRocket',
        site: 'logrocket.com',
        deps: ['logrocket'],
        code: ['LogRocket\\.init\\(']
      },
      {
        id: 'cf_error_dataset',
        label: 'Errors in Cloudflare Analytics Engine',
        keyProvider: 'cloudflare',
        code: ['dataset["\']?\\s*[:=]\\s*["\'][\\w-]*error'],
        codeIn: ['wrangler\\.(toml|jsonc?)$']
      },
      {
        id: 'own_error_alert',
        label: 'Own error alerts',
        code: ['onError\\([\\s\\S]{0,800}?([Nn]otify|NOTIFY|[Ss]lack|SLACK|[Ww]ebhook|WEBHOOK|postMessage|sendAlert)'],
        fallback: true
      }
    ]
  },
  {
    id: 'logging',
    label: 'Logs',
    group: 'watch',
    missing: "When something fails, there's no record of why",
    appliesTo: ['worker', 'web', 'desktop'],
    recommend: 'cf_observability',
    providers: [
      {
        id: 'cf_observability',
        label: 'Cloudflare Workers Logs',
        keyProvider: 'cloudflare',
        code: ['^\\s*\\[observability\\]', '"observability"\\s*:'],
        codeIn: ['wrangler\\.(toml|jsonc?)$']
      },
      { id: 'axiom', label: 'Axiom', site: 'axiom.co', deps: ['@axiomhq/'] },
      {
        id: 'betterstack_logs',
        label: 'Better Stack Logs',
        site: 'betterstack.com',
        deps: ['@logtail/']
      },
      { id: 'datadog', label: 'Datadog', keyProvider: 'datadog', deps: ['dd-trace', '@datadog/'] },
      { id: 'pino', label: 'pino', site: 'getpino.io', deps: ['pino'] },
      { id: 'winston', label: 'winston', site: 'github.com', deps: ['winston'] },
      { id: 'electron_log', label: 'electron-log', site: 'github.com', deps: ['electron-log'] },
      {
        id: 'cf_analytics_engine',
        label: 'Cloudflare Analytics Engine',
        keyProvider: 'cloudflare',
        code: ['analytics_engine_datasets', 'writeDataPoint\\(']
      }
    ]
  },
  {
    id: 'health',
    label: 'Uptime check',
    group: 'watch',
    missing: 'If the site goes down, nobody notices',
    appliesTo: ['worker', 'web'],
    recommend: 'health_route',
    providers: [
      {
        id: 'health_route',
        label: '/health page',
        code: ['[\'"`]/(api/)?(health|healthz|status)[\'"`]'],
        files: [
          '(^|/)functions/(api/)?healthz?\\.[jt]s$',
          '(^|/)app/(api/)?healthz?/route\\.[jt]s$',
          '(^|/)pages/api/healthz?\\.[jt]sx?$'
        ]
      },
      {
        id: 'betterstack_uptime',
        label: 'Better Stack Uptime',
        site: 'betterstack.com',
        code: ['uptime\\.betterstack\\.com']
      },
      { id: 'checkly', label: 'Checkly', site: 'checklyhq.com', deps: ['checkly'] }
    ]
  },
  {
    id: 'auth',
    label: 'Sign-in',
    ask: 'Should people sign in?',
    group: 'users',
    missing: "People can't sign in",
    appliesTo: ['web', 'mobile', 'desktop'],
    recommend: 'better_auth',
    providers: [
      {
        id: 'better_auth',
        label: 'Better Auth',
        site: 'better-auth.com',
        deps: ['better-auth', 'better-auth-cloudflare', '@better-auth/'],
        code: ['betterAuth\\(']
      },
      {
        id: 'supabase_auth',
        label: 'Supabase Auth',
        keyProvider: 'supabase',
        code: ['\\.auth\\.(signIn|signUp|getUser|getSession|signInWithOAuth|signInWithOtp)']
      },
      {
        id: 'firebase_auth',
        label: 'Firebase Auth',
        keyProvider: 'firebase',
        deps: ['@react-native-firebase/auth'],
        code: [
          'getAuth\\(',
          'signInWithPopup\\(',
          'admin\\.auth\\(\\)',
          'from [\'"]firebase/auth[\'"]'
        ]
      },
      { id: 'clerk', label: 'Clerk', site: 'clerk.com', deps: ['@clerk/'] },
      { id: 'authjs', label: 'Auth.js', site: 'authjs.dev', deps: ['next-auth', '@auth/'] },
      {
        id: 'apple_signin',
        label: 'Sign in with Apple',
        keyProvider: 'apple',
        noKey: true,
        deps: ['expo-apple-authentication'],
        code: ['ASAuthorizationAppleIDProvider']
      },
      {
        id: 'google_signin',
        label: 'Google Sign-In',
        site: 'google.com',
        deps: ['@react-native-google-signin/google-signin', 'expo-auth-session'],
        code: ['accounts\\.google\\.com/o/oauth2']
      },
      {
        id: 'custom_session',
        label: 'Own sign-in code',
        deps: ['jose', 'jsonwebtoken', '@tsndr/cloudflare-worker-jwt'],
        code: ['[Ss]et-[Cc]ookie[^\\n]{0,120}[Ss]ession', '[a-z]_session=', 'sessionHash'],
        fallback: true
      }
    ]
  },
  {
    id: 'payments',
    label: 'Payments',
    ask: 'Should it take money?',
    group: 'users',
    missing: 'No way to take money',
    appliesTo: ['web', 'mobile', 'desktop'],
    recommend: 'stripe',
    providers: [
      ...MONEY_SOURCES,
      {
        id: 'storekit',
        label: 'StoreKit',
        keyProvider: 'apple',
        noKey: true,
        deps: ['expo-in-app-purchases', 'react-native-iap'],
        code: ['import StoreKit']
      },
      { id: 'cardcom', label: 'CardCom', site: 'cardcom.solutions', code: ['cardcom'] },
      { id: 'x402', label: 'x402', site: 'x402.org', deps: ['x402', 'x402-hono', '@coinbase/x402'] }
    ]
  },
  {
    id: 'revenue',
    label: 'Revenue',
    group: 'users',
    missing: "You can't see what you earn",
    appliesTo: ['web', 'mobile', 'desktop'],
    recommend: 'stripe',
    providers: [
      ...MONEY_SOURCES,
      {
        id: 'chartmogul',
        label: 'ChartMogul',
        site: 'chartmogul.com',
        deps: ['chartmogul-node'],
        code: ['api\\.chartmogul\\.com']
      },
      { id: 'baremetrics', label: 'Baremetrics', site: 'baremetrics.com', code: ['api\\.baremetrics\\.com'] }
    ]
  },
  {
    id: 'email',
    label: 'Email',
    ask: 'Should it send email?',
    group: 'users',
    missing: "The app can't send receipts, sign-in links or alerts",
    appliesTo: ['web', 'worker'],
    recommend: 'resend',
    providers: [
      {
        id: 'resend',
        label: 'Resend',
        keyProvider: 'resend',
        deps: ['resend'],
        code: ['api\\.resend\\.com', 'new Resend\\(']
      },
      {
        id: 'cf_email',
        label: 'Cloudflare Email',
        keyProvider: 'cloudflare',
        code: ['send_email', '\\.sendEmail\\(', 'cloudflare:email']
      },
      {
        id: 'postmark',
        label: 'Postmark',
        keyProvider: 'postmark',
        deps: ['postmark'],
        code: ['api\\.postmarkapp\\.com']
      },
      {
        id: 'sendgrid',
        label: 'SendGrid',
        keyProvider: 'sendgrid',
        deps: ['@sendgrid/'],
        code: ['api\\.sendgrid\\.com']
      },
      {
        id: 'mailgun',
        label: 'Mailgun',
        keyProvider: 'mailgun',
        deps: ['mailgun.js', 'mailgun-js']
      },
      {
        id: 'ses',
        label: 'Amazon SES',
        keyProvider: 'aws',
        deps: ['@aws-sdk/client-ses', '@aws-sdk/client-sesv2']
      },
      {
        id: 'zoho_mail',
        label: 'Zoho Mail',
        keyProvider: 'zoho',
        code: ['mail\\.zoho\\.com/api', 'smtp\\.zoho']
      },
      {
        id: 'loops',
        label: 'Loops',
        site: 'loops.so',
        deps: ['loops'],
        code: ['app\\.loops\\.so/api']
      }
    ]
  },
  {
    id: 'push',
    label: 'Push notifications',
    ask: 'Should it send alerts to phones?',
    group: 'users',
    missing: "You can't reach people when the app is closed",
    appliesTo: ['mobile'],
    recommend: 'expo_notifications',
    optional: true,
    providers: [
      {
        id: 'expo_notifications',
        label: 'Expo Notifications',
        site: 'expo.dev',
        deps: ['expo-notifications']
      },
      {
        id: 'fcm',
        label: 'Firebase Messaging',
        keyProvider: 'firebase',
        deps: ['@react-native-firebase/messaging']
      },
      {
        id: 'onesignal',
        label: 'OneSignal',
        site: 'onesignal.com',
        deps: ['react-native-onesignal', 'onesignal-expo-plugin']
      },
      {
        id: 'apns',
        label: 'Apple push',
        keyProvider: 'apple',
        code: ['registerForRemoteNotifications']
      }
    ]
  },
  {
    id: 'database',
    label: 'Database',
    ask: 'Should it save things between visits?',
    group: 'runs',
    missing: 'Nothing is saved between visits',
    appliesTo: ALL,
    providers: [
      {
        id: 'd1',
        label: 'Cloudflare D1',
        keyProvider: 'cloudflare',
        code: ['d1_databases', 'D1Database']
      },
      {
        id: 'cf_kv',
        label: 'Cloudflare KV',
        keyProvider: 'cloudflare',
        code: ['kv_namespaces', 'KVNamespace']
      },
      {
        id: 'durable_objects',
        label: 'Durable Objects',
        keyProvider: 'cloudflare',
        code: ['durable_objects', 'DurableObject\\b']
      },
      {
        id: 'r2',
        label: 'Cloudflare R2',
        keyProvider: 'cloudflare',
        code: ['r2_buckets', 'R2Bucket']
      },
      {
        id: 'supabase',
        label: 'Supabase',
        keyProvider: 'supabase',
        deps: ['@supabase/supabase-js', '@supabase/ssr'],
        code: ['createClient\\(.*supabase', '\\.supabase\\.co']
      },
      {
        id: 'firestore',
        label: 'Firestore',
        keyProvider: 'firebase',
        deps: ['@react-native-firebase/firestore'],
        code: ['getFirestore\\(', 'admin\\.firestore\\(\\)']
      },
      {
        id: 'postgres',
        label: 'Postgres',
        keyProvider: 'postgres',
        deps: ['pg', 'postgres', '@neondatabase/serverless']
      },
      {
        id: 'sqlite_local',
        label: 'SQLite',
        site: 'sqlite.org',
        deps: ['better-sqlite3', 'expo-sqlite', 'sqlite3']
      },
      { id: 's3', label: 'Amazon S3', keyProvider: 'aws', deps: ['@aws-sdk/client-s3'] }
    ]
  },
  {
    id: 'backups',
    label: 'Backups',
    group: 'runs',
    missing: 'If the database is lost, it stays lost',
    appliesTo: ALL,
    recommend: 'backup_script',
    optional: true,
    providers: [
      {
        id: 'd1_time_travel',
        label: 'D1 Time Travel',
        keyProvider: 'cloudflare',
        noKey: true,
        code: ['d1_databases', 'D1Database']
      },
      { id: 'litestream', label: 'Litestream', site: 'litestream.io', files: ['(^|/)litestream\\.ya?ml$'] },
      {
        id: 'backup_script',
        label: 'Backup script',
        code: ['pg_dump', 'supabase db dump', 'd1 export']
      }
    ]
  },
  {
    id: 'hosting',
    label: 'Hosting',
    group: 'runs',
    missing: 'No known place this runs',
    appliesTo: ALL,
    providers: [
      {
        id: 'cloudflare',
        label: 'Cloudflare',
        keyProvider: 'cloudflare',
        deps: ['wrangler'],
        files: ['(^|/)wrangler\\.(toml|jsonc?)$']
      },
      { id: 'vercel', label: 'Vercel', keyProvider: 'vercel', files: ['(^|/)vercel\\.json$'] },
      {
        id: 'firebase_hosting',
        label: 'Firebase Hosting',
        keyProvider: 'firebase',
        deps: ['firebase-tools'],
        files: ['(^|/)firebase\\.json$']
      },
      { id: 'netlify', label: 'Netlify', keyProvider: 'netlify', files: ['(^|/)netlify\\.toml$'] },
      { id: 'fly', label: 'Fly.io', keyProvider: 'fly', files: ['(^|/)fly\\.toml$'] },
      { id: 'eas', label: 'Expo EAS', site: 'expo.dev', files: ['(^|/)eas\\.json$'] },
      {
        id: 'electron_builder',
        label: 'electron-builder',
        site: 'electron.build',
        deps: ['electron-builder']
      },
      {
        id: 'shopify_theme',
        label: 'Shopify store',
        keyProvider: 'shopify',
        deps: ['@shopify/cli'],
        files: ['(^|/)layout/theme\\.liquid$'],
        covers: ['auth', 'email', 'database', 'seo']
      }
    ]
  },
  {
    id: 'updates',
    label: 'App updates',
    group: 'runs',
    missing: 'People stay on old versions until they reinstall',
    appliesTo: ['mobile', 'desktop'],
    providers: [
      {
        id: 'expo_updates',
        label: 'EAS Update',
        site: 'expo.dev',
        deps: ['expo-updates'],
        onlyFor: ['mobile']
      },
      {
        id: 'electron_updater',
        label: 'electron-updater',
        site: 'electron.build',
        deps: ['electron-updater'],
        onlyFor: ['desktop']
      },
      {
        id: 'sparkle',
        label: 'Sparkle',
        site: 'sparkle-project.org',
        code: ['import Sparkle', 'SPUStandardUpdaterController'],
        onlyFor: ['desktop']
      }
    ]
  },
  {
    id: 'ci',
    label: 'Checks on every push',
    group: 'runs',
    missing: 'Broken code can ship without anything catching it',
    appliesTo: ALL,
    recommend: 'github_actions',
    providers: [
      {
        id: 'github_actions',
        label: 'GitHub Actions',
        keyProvider: 'github',
        noKey: true,
        files: ['^\\.github/workflows/[^/]+\\.ya?ml$']
      },
      {
        id: 'eas_workflows',
        label: 'EAS Workflows',
        site: 'expo.dev',
        files: ['^\\.eas/workflows/']
      }
    ]
  },
  {
    id: 'tests',
    label: 'Tests',
    group: 'runs',
    missing: 'A change can break something without anyone noticing',
    appliesTo: ALL,
    recommend: 'vitest',
    providers: [
      { id: 'vitest', label: 'Vitest', site: 'vitest.dev', deps: ['vitest'] },
      { id: 'jest', label: 'Jest', site: 'jestjs.io', deps: ['jest', 'jest-expo'] },
      { id: 'playwright', label: 'Playwright', site: 'playwright.dev', deps: ['@playwright/test'] },
      {
        id: 'node_test',
        label: 'node:test',
        site: 'nodejs.org',
        code: ['from [\'"]node:test[\'"]']
      },
      { id: 'xctest', label: 'XCTest', keyProvider: 'apple', noKey: true, code: ['import XCTest'] }
    ]
  },
  {
    id: 'abuse',
    label: 'Bot protection',
    group: 'safety',
    missing: 'Bots can spam sign-ups and forms',
    appliesTo: ['web', 'worker'],
    recommend: 'turnstile',
    providers: [
      {
        id: 'turnstile',
        label: 'Turnstile',
        keyProvider: 'turnstile',
        deps: ['@marsidev/react-turnstile'],
        code: ['challenges\\.cloudflare\\.com/turnstile', 'siteverify']
      },
      {
        id: 'cf_ratelimit',
        label: 'Cloudflare rate limit',
        keyProvider: 'cloudflare',
        code: [
          '\\[\\[?unsafe\\.bindings\\]\\]?.*ratelimit',
          '"ratelimits"',
          '\\[\\[ratelimits\\]\\]'
        ]
      },
      {
        id: 'express_ratelimit',
        label: 'express-rate-limit',
        site: 'expressjs.com',
        deps: ['express-rate-limit']
      },
      {
        id: 'recaptcha',
        label: 'reCAPTCHA',
        site: 'google.com',
        deps: ['react-google-recaptcha'],
        code: ['google\\.com/recaptcha']
      },
      { id: 'hcaptcha', label: 'hCaptcha', site: 'hcaptcha.com', deps: ['@hcaptcha/'] }
    ]
  },
  {
    id: 'seo',
    label: 'Search (SEO)',
    ask: 'Should people find it on Google?',
    group: 'safety',
    missing: 'Search engines find less of the site',
    appliesTo: ['web'],
    recommend: 'sitemap',
    providers: [
      {
        id: 'sitemap',
        label: 'Sitemap',
        deps: ['@astrojs/sitemap', 'next-sitemap'],
        code: ['sitemap\\.xml', '\\bsitemap\\('],
        files: ['(^|/)sitemap[^/]*\\.(xml|ts|js)$']
      },
      {
        id: 'robots',
        label: 'robots.txt',
        code: ['[\'"`]/robots\\.txt[\'"`]'],
        files: ['(^|/)robots\\.(txt|ts|js)$']
      },
      { id: 'og_image', label: 'Share image', deps: ['@vercel/og', 'satori'], code: ['og:image'] }
    ]
  },
  {
    id: 'legal',
    label: 'Privacy + terms',
    group: 'safety',
    missing: 'App stores and payment providers can turn you away',
    appliesTo: ['web', 'mobile'],
    recommend: 'privacy_page',
    providers: [
      {
        id: 'privacy_page',
        label: 'Privacy page',
        code: ['[\'"`]/privacy(-policy)?[\'"`/]'],
        files: ['(^|/)privacy(-policy)?(\\.[a-z]+|/index\\.[a-z]+)$']
      },
      {
        id: 'terms_page',
        label: 'Terms page',
        code: ['[\'"`]/terms(-of-service)?[\'"`/]'],
        files: ['(^|/)terms(-of-service)?(\\.[a-z]+|/index\\.[a-z]+)$']
      }
    ]
  }
]

export function infraKind(id: string): InfraKind | undefined {
  return INFRA_KINDS.find((k) => k.id === id)
}

export function infraProvider(kindId: string, providerId: string): InfraProvider | undefined {
  return (
    infraKind(kindId)?.providers.find((p) => p.id === providerId) ??
    INFRA_KINDS.flatMap((k) => k.providers).find(
      (p) => p.id === providerId && p.covers?.includes(kindId)
    )
  )
}

export function kindApplies(kind: InfraKind, appKinds: AppKind[]): boolean {
  return appKinds.length === 0 || kind.appliesTo.some((k) => appKinds.includes(k))
}

export function providerFits(provider: InfraProvider, appKinds: AppKind[]): boolean {
  return (
    !provider.onlyFor || appKinds.length === 0 || provider.onlyFor.some((k) => appKinds.includes(k))
  )
}

export const BUSINESS_WANTS: Record<BusinessType, string[]> = {
  store: ['payments', 'email', 'database', 'seo', 'product_analytics'],
  saas: ['auth', 'payments', 'email', 'database', 'product_analytics'],
  app: ['auth', 'payments', 'push', 'database', 'product_analytics'],
  marketplace: ['auth', 'payments', 'email', 'database', 'seo', 'product_analytics'],
  extension: ['product_analytics'],
  devtool: [],
  content: ['seo', 'email'],
  landing: ['seo', 'email'],
  internal: ['auth', 'database']
}

export function suggestedBy(kind: InfraKind, record: InfraRecord): BusinessType[] {
  return (record.business ?? []).filter((b) => BUSINESS_WANTS[b].includes(kind.id))
}

export function kindWanted(kind: InfraKind, record: InfraRecord): boolean {
  if (record.skip.includes(kind.id)) return false
  if (record.want?.includes(kind.id)) return true
  if (!kindApplies(kind, record.appKinds)) return false
  if (kind.ask && record.business?.length) return suggestedBy(kind, record).length > 0
  return !kind.optional
}

export function infraNeeds(record: InfraRecord | null): InfraKind[] {
  if (!record) return []
  return INFRA_KINDS.filter(
    (k) => kindWanted(k, record) && (record.services[k.id] ?? []).length === 0
  )
}

export function usualProvider(
  kind: InfraKind,
  all: ProjectInfra[],
  exceptProjectId: string
): {
  provider: InfraProvider
  usedIn: string[]
} | null {
  const appKinds = all.find((p) => p.projectId === exceptProjectId)?.record?.appKinds ?? []
  const uses = new Map<string, string[]>()
  for (const p of all) {
    if (p.projectId === exceptProjectId) continue
    for (const e of p.record?.services[kind.id] ?? []) {
      if (!e.manual || kind.providers.some((x) => x.id === e.provider)) {
        uses.set(e.provider, [...(uses.get(e.provider) ?? []), p.projectId])
      }
    }
  }
  const ranked = [...uses.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [id, usedIn] of ranked) {
    const provider = kind.providers.find((x) => x.id === id)
    if (provider && !provider.fallback && providerFits(provider, appKinds))
      return { provider, usedIn }
  }
  const fallback = kind.providers.find((x) => x.id === kind.recommend && providerFits(x, appKinds))
  return fallback ? { provider: fallback, usedIn: [] } : null
}

export function infraSetupPrompt(
  kind: InfraKind,
  provider: InfraProvider,
  keyNames: string[],
  business: BusinessType[] = [],
  brief?: ProjectBrief
): string {
  const keys = keyNames.length
    ? ` Read keys from ${keyNames.join(' / ')} - never paste a key value into code.`
    : ''
  const kinds = business
    .map((type) => `${BUSINESS_LABELS[type].label} (${BUSINESS_LABELS[type].hint})`)
    .join(' ')
  const what = [briefSentence(brief), kinds && `${kinds}.`].filter(Boolean).join(' ')
  return [
    ...(what ? [`What this project is: ${what} Set it up the way that kind of project needs.`] : []),
    `Add ${provider.label} to this project for ${kind.label.toLowerCase()}.`,
    `Wire it the way this codebase already does similar things, the smallest change that fully works.${keys}`,
    'If a step needs me (making an account, a dashboard click, pasting a key), stop and tell me exactly that step as one line.'
  ].join('\n')
}

export function infraFixPrompt(
  kind: InfraKind,
  label: string,
  entry: InfraEntry,
  keyName: string,
  problem: string
): string {
  return [
    `${label} (${kind.label.toLowerCase()}) is wired into this project${entry.foundIn ? ` at ${entry.foundIn}` : ''}, but its key ${keyName} is not working: ${problem.toLowerCase()}.`,
    `Find where ${keyName} is read, check which value the code expects, and get it working end to end. Never paste a key value into code or into this chat.`,
    `If the key is missing, tell me the one place to get it, then have me save it with MightyMouse Keys. Finish by confirming ${label} actually receives data.`
  ].join('\n')
}

export interface SetupSuggestion {
  summary: string
  tasks: string[]
}

export function setupSuggestPrompt(repo: string, record: InfraRecord): string {
  const found = INFRA_KINDS.flatMap((k) =>
    (record.services[k.id] ?? []).map((e) => `${k.label}: ${infraProvider(k.id, e.provider)?.label ?? e.provider}`)
  )
  const missing = infraNeeds(record).map((k) => k.label)
  return [
    `A person just connected the code repo "${repo}" to an AI that writes code for them.`,
    `App type: ${record.appKinds.join(', ') || 'unknown'}.`,
    `Services found in the code: ${found.join('; ') || 'none'}.`,
    `Not set up yet: ${missing.join('; ') || 'nothing'}.`,
    'Reply with JSON only: {"summary": string, "tasks": [string, string, string]}.',
    'summary: one or two plain sentences telling them what their app is built on, no jargon, no service they do not use.',
    'tasks: three small first changes they could ask for, each one sentence starting with a verb, each finishable in one pull request. At most one about a missing service.'
  ].join('\n')
}

export function parseSetupSuggestion(text: string): SetupSuggestion | null {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    const parsed = JSON.parse(json) as Partial<SetupSuggestion>
    const tasks = (parsed.tasks ?? []).filter((t): t is string => typeof t === 'string' && !!t.trim())
    if (typeof parsed.summary !== 'string' || !tasks.length) return null
    return { summary: parsed.summary.trim(), tasks: tasks.slice(0, 3) }
  } catch {
    return null
  }
}
