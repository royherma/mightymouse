import type { KeyProvider } from './keys'

export const KEY_PROVIDERS: KeyProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    category: 'ai',
    envNames: ['ANTHROPIC_API_KEY'],
    shapes: [{ prefix: 'sk-ant-', label: 'API key' }],
    cli: { bin: 'claude', probe: ['auth', 'status'], loginHint: 'claude login' },
    docsUrl: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    category: 'ai',
    envNames: ['DEEPSEEK_API_KEY'],
    shapes: [{ prefix: 'sk-', label: 'API key' }],
    docsUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    category: 'ai',
    envNames: ['ELEVENLABS_API_KEY'],
    shapes: [],
    docsUrl: 'https://elevenlabs.io/app/settings/api-keys'
  },
  {
    id: 'google-gemini',
    label: 'Google Gemini',
    category: 'ai',
    envNames: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    shapes: [{ prefix: 'AIza', label: 'API key' }],
    docsUrl: 'https://aistudio.google.com/app/apikey'
  },
  {
    id: 'groq',
    label: 'Groq',
    category: 'ai',
    envNames: ['GROQ_API_KEY'],
    shapes: [{ prefix: 'gsk_', label: 'API key' }],
    docsUrl: 'https://console.groq.com/keys'
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    category: 'ai',
    envNames: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
    shapes: [{ prefix: 'hf_', label: 'access token' }],
    mcpUrl: 'https://huggingface.co/mcp',
    docsUrl: 'https://huggingface.co/settings/tokens'
  },
  {
    id: 'mistral',
    label: 'Mistral',
    category: 'ai',
    envNames: ['MISTRAL_API_KEY'],
    shapes: [],
    docsUrl: 'https://console.mistral.ai/api-keys'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    category: 'ai',
    envNames: ['OPENAI_API_KEY'],
    shapes: [
      { prefix: 'sk-proj-', label: 'project key' },
      { prefix: 'sk-', label: 'API key' }
    ],
    cli: { bin: 'codex', probe: ['login', 'status'], loginHint: 'codex login' },
    docsUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    category: 'ai',
    envNames: ['OPENROUTER_API_KEY'],
    shapes: [{ prefix: 'sk-or-', label: 'API key' }],
    docsUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    category: 'ai',
    envNames: ['PERPLEXITY_API_KEY'],
    shapes: [{ prefix: 'pplx-', label: 'API key' }],
    docsUrl: 'https://www.perplexity.ai/settings/api'
  },
  {
    id: 'replicate',
    label: 'Replicate',
    category: 'ai',
    envNames: ['REPLICATE_API_TOKEN'],
    shapes: [{ prefix: 'r8_', label: 'API token' }],
    docsUrl: 'https://replicate.com/account/api-tokens'
  },
  {
    id: 'apple',
    label: 'Apple',
    category: 'apple',
    envNames: [
      'APP_STORE_CONNECT_KEY_ID',
      'APP_STORE_CONNECT_ISSUER_ID',
      'ASC_API_KEY_PATH',
      'ASC_KEY_ID',
      'ASC_ISSUER_ID',
      'ASC_KEY_PATH',
      'APPLE_ID',
      'APPLE_TEAM_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APNS_KEY_ID',
      'APNS_TEAM_ID',
      'APNS_KEY_PATH'
    ],
    shapes: [],
    stems: ['APNS', 'ASC'],
    detect: ['ios'],
    docsUrl: 'https://appstoreconnect.apple.com/access/integrations/api'
  },
  {
    id: 'aws',
    label: 'AWS',
    category: 'infra',
    envNames: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    shapes: [{ prefix: 'AKIA', label: 'access key id' }],
    docsUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials'
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    category: 'infra',
    envNames: ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    shapes: [],
    cli: { bin: 'wrangler', probe: ['whoami'], loginHint: 'wrangler login' },
    cloud: 'cloudflare',
    detect: ['wrangler.toml', 'wrangler.jsonc', '.dev.vars'],
    mcpUrl: 'https://bindings.mcp.cloudflare.com/mcp',
    docsUrl: 'https://dash.cloudflare.com/profile/api-tokens'
  },
  {
    id: 'digitalocean',
    label: 'DigitalOcean',
    category: 'infra',
    envNames: ['DIGITALOCEAN_ACCESS_TOKEN', 'DO_API_TOKEN'],
    shapes: [{ prefix: 'dop_v1_', label: 'API token' }],
    mcpUrl: 'https://mcp.digitalocean.com/mcp',
    docsUrl: 'https://cloud.digitalocean.com/account/api/tokens'
  },
  {
    id: 'firebase',
    label: 'Firebase',
    category: 'infra',
    envNames: ['FIREBASE_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS'],
    shapes: [],
    cli: { bin: 'firebase', probe: ['login:list'], loginHint: 'firebase login' },
    docsUrl: 'https://console.firebase.google.com'
  },
  {
    id: 'fly',
    label: 'Fly.io',
    category: 'infra',
    envNames: ['FLY_API_TOKEN'],
    shapes: [{ prefix: 'fo1_', label: 'API token' }],
    cli: { bin: 'flyctl', probe: ['auth', 'whoami'], loginHint: 'flyctl auth login' },
    docsUrl: 'https://fly.io/user/personal_access_tokens'
  },
  {
    id: 'gcloud',
    label: 'Google Cloud',
    category: 'infra',
    envNames: ['GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT'],
    shapes: [],
    cli: { bin: 'gcloud', probe: ['auth', 'list'], loginHint: 'gcloud auth login' },
    docsUrl: 'https://console.cloud.google.com/apis/credentials'
  },
  {
    id: 'netlify',
    label: 'Netlify',
    category: 'infra',
    envNames: ['NETLIFY_AUTH_TOKEN'],
    shapes: [],
    cli: { bin: 'netlify', probe: ['status'], loginHint: 'netlify login' },
    detect: ['netlify.toml'],
    mcpUrl: 'https://netlify-mcp.netlify.app/mcp',
    docsUrl: 'https://app.netlify.com/user/applications'
  },
  {
    id: 'railway',
    label: 'Railway',
    category: 'infra',
    envNames: ['RAILWAY_TOKEN'],
    shapes: [],
    cli: { bin: 'railway', probe: ['whoami'], loginHint: 'railway login' },
    mcpUrl: 'https://mcp.railway.com',
    docsUrl: 'https://railway.app/account/tokens'
  },
  {
    id: 'render',
    label: 'Render',
    category: 'infra',
    envNames: ['RENDER_API_KEY'],
    shapes: [{ prefix: 'rnd_', label: 'API key' }],
    mcpUrl: 'https://mcp.render.com/mcp',
    docsUrl: 'https://dashboard.render.com/u/settings#api-keys'
  },
  {
    id: 'supabase',
    label: 'Supabase',
    category: 'infra',
    envNames: [
      'SUPABASE_ACCESS_TOKEN',
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SERVICE_ROLE_KEY',
      'SUPABASE_PROJECT_REF',
      'SUPABASE_DB_PASSWORD',
      'STAGING_ACCESS_TOKEN'
    ],
    shapes: [
      { prefix: 'sbp_', label: 'access token' },
      { prefix: 'sb_secret_', label: 'secret key' },
      { prefix: 'sb_publishable_', label: 'publishable key' },
      { prefix: 'eyJ', label: 'anon/service JWT' }
    ],
    cli: { bin: 'supabase', probe: ['projects', 'list'], loginHint: 'supabase login' },
    cloud: 'supabase',
    detect: ['supabase/config.toml', 'supabase'],
    mcpUrl: 'https://mcp.supabase.com/mcp',
    docsUrl: 'https://supabase.com/dashboard/account/tokens'
  },
  {
    id: 'vercel',
    label: 'Vercel',
    category: 'infra',
    envNames: ['VERCEL_TOKEN'],
    shapes: [],
    cli: { bin: 'vercel', probe: ['whoami'], loginHint: 'vercel login' },
    cloud: 'vercel',
    detect: ['.vercel', 'vercel.json'],
    mcpUrl: 'https://mcp.vercel.com',
    docsUrl: 'https://vercel.com/account/tokens'
  },
  {
    id: 'github',
    label: 'GitHub',
    category: 'devtools',
    envNames: ['GITHUB_TOKEN', 'GH_TOKEN'],
    shapes: [
      { prefix: 'ghp_', label: 'classic PAT' },
      { prefix: 'github_pat_', label: 'fine-grained PAT' }
    ],
    cli: { bin: 'gh', probe: ['auth', 'status'], loginHint: 'gh auth login' },
    cloud: 'github',
    detect: ['.github'],
    mcp: ['github'],
    mcpUrl: 'https://api.githubcopilot.com/mcp/',
    docsUrl: 'https://github.com/settings/tokens'
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    category: 'devtools',
    envNames: ['GITLAB_TOKEN'],
    shapes: [{ prefix: 'glpat-', label: 'personal access token' }],
    mcpUrl: 'https://gitlab.com/api/v4/mcp',
    docsUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens'
  },
  {
    id: 'docker',
    label: 'Docker Hub',
    category: 'devtools',
    envNames: ['DOCKERHUB_TOKEN', 'DOCKER_PASSWORD'],
    shapes: [{ prefix: 'dckr_pat_', label: 'access token' }],
    cli: { bin: 'docker', probe: ['info'], loginHint: 'docker login' },
    docsUrl: 'https://hub.docker.com/settings/security'
  },
  {
    id: 'npm',
    label: 'npm',
    category: 'devtools',
    envNames: ['NPM_TOKEN'],
    shapes: [{ prefix: 'npm_', label: 'access token' }],
    cli: { bin: 'npm', probe: ['whoami'], loginHint: 'npm login' },
    docsUrl: 'https://www.npmjs.com/settings/~/tokens'
  },
  {
    id: 'sentry',
    label: 'Sentry',
    category: 'devtools',
    envNames: ['SENTRY_AUTH_TOKEN', 'SENTRY_DSN'],
    shapes: [
      { prefix: 'sntrys_', label: 'org token' },
      { prefix: 'sntryu_', label: 'user token' }
    ],
    cli: { bin: 'sentry-cli', probe: ['info'], loginHint: 'sentry-cli login' },
    mcp: ['sentry'],
    mcpUrl: 'https://mcp.sentry.dev/mcp',
    docsUrl: 'https://sentry.io/settings/account/api/auth-tokens/'
  },
  {
    id: 'zapier',
    label: 'Zapier',
    category: 'devtools',
    envNames: ['ZAPIER_API_KEY'],
    shapes: [],
    mcpUrl: 'https://mcp.zapier.com/api/mcp/mcp',
    docsUrl: 'https://zapier.com/app/settings/api-keys'
  },
  {
    id: 'make',
    label: 'Make',
    category: 'devtools',
    envNames: ['MAKE_API_TOKEN'],
    shapes: [],
    mcpUrl: 'https://mcp.make.com',
    docsUrl: 'https://www.make.com'
  },
  {
    id: 'postgres',
    label: 'Postgres',
    category: 'data',
    envNames: ['DATABASE_URL', 'POSTGRES_URL'],
    shapes: [{ prefix: 'postgres://', label: 'connection string' }],
    docsUrl: 'https://www.postgresql.org/docs/current/libpq-connect.html'
  },
  {
    id: 'mongodb',
    label: 'MongoDB',
    category: 'data',
    envNames: ['MONGODB_URI'],
    shapes: [{ prefix: 'mongodb+srv://', label: 'connection string' }],
    docsUrl: 'https://cloud.mongodb.com'
  },
  {
    id: 'redis',
    label: 'Redis',
    category: 'data',
    envNames: ['REDIS_URL'],
    shapes: [{ prefix: 'redis://', label: 'connection string' }],
    docsUrl: 'https://redis.io/cloud'
  },
  {
    id: 'planetscale',
    label: 'PlanetScale',
    category: 'data',
    envNames: ['PLANETSCALE_TOKEN', 'DATABASE_URL'],
    shapes: [{ prefix: 'pscale_tkn_', label: 'API token' }],
    cli: { bin: 'pscale', probe: ['auth', 'whoami'], loginHint: 'pscale auth login' },
    docsUrl: 'https://app.planetscale.com'
  },
  {
    id: 'airtable',
    label: 'Airtable',
    category: 'data',
    envNames: ['AIRTABLE_API_KEY'],
    shapes: [{ prefix: 'pat', label: 'personal access token' }],
    mcpUrl: 'https://mcp.airtable.com/mcp',
    docsUrl: 'https://airtable.com/create/tokens'
  },
  {
    id: 'notion',
    label: 'Notion',
    category: 'data',
    envNames: ['NOTION_API_KEY', 'NOTION_TOKEN'],
    shapes: [
      { prefix: 'secret_', label: 'integration secret' },
      { prefix: 'ntn_', label: 'integration secret' }
    ],
    mcpUrl: 'https://mcp.notion.com/mcp',
    docsUrl: 'https://www.notion.so/my-integrations'
  },
  {
    id: 'neon',
    label: 'Neon',
    category: 'data',
    envNames: ['NEON_API_KEY'],
    shapes: [{ prefix: 'napi_', label: 'API key' }],
    mcpUrl: 'https://mcp.neon.tech/mcp',
    docsUrl: 'https://console.neon.tech/app/settings/api-keys'
  },
  {
    id: 'dropbox',
    label: 'Dropbox',
    category: 'data',
    envNames: ['DROPBOX_ACCESS_TOKEN', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET'],
    shapes: [{ prefix: 'sl.', label: 'access token' }],
    mcpUrl: 'https://mcp.dropbox.com/mcp',
    docsUrl: 'https://www.dropbox.com/developers/apps'
  },
  {
    id: 'box',
    label: 'Box',
    category: 'data',
    envNames: ['BOX_CLIENT_ID', 'BOX_CLIENT_SECRET', 'BOX_DEVELOPER_TOKEN'],
    shapes: [],
    mcpUrl: 'https://mcp.box.com',
    docsUrl: 'https://app.box.com/developers/console'
  },
  {
    id: 'evernote',
    label: 'Evernote',
    category: 'data',
    envNames: [],
    shapes: [],
    mcpUrl: 'https://mcp.evernote.com/mcp',
    docsUrl: 'https://dev.evernote.com'
  },
  {
    id: 'linear',
    label: 'Linear',
    category: 'devtools',
    envNames: ['LINEAR_API_KEY'],
    shapes: [{ prefix: 'lin_api_', label: 'API key' }],
    mcpUrl: 'https://mcp.linear.app/mcp',
    docsUrl: 'https://linear.app/settings/api'
  },
  {
    id: 'figma',
    label: 'Figma',
    category: 'devtools',
    envNames: ['FIGMA_ACCESS_TOKEN', 'FIGMA_TOKEN'],
    shapes: [{ prefix: 'figd_', label: 'personal access token' }],
    mcpUrl: 'https://mcp.figma.com/mcp',
    docsUrl: 'https://www.figma.com/developers/api#access-tokens'
  },
  {
    id: 'canva',
    label: 'Canva',
    category: 'devtools',
    envNames: ['CANVA_CLIENT_ID', 'CANVA_CLIENT_SECRET'],
    shapes: [],
    mcpUrl: 'https://mcp.canva.com/mcp',
    docsUrl: 'https://www.canva.dev/docs/connect/'
  },
  {
    id: 'lovable',
    label: 'Lovable',
    category: 'devtools',
    envNames: [],
    shapes: [],
    mcpUrl: 'https://mcp.lovable.dev',
    docsUrl: 'https://docs.lovable.dev'
  },
  {
    id: 'webflow',
    label: 'Webflow',
    category: 'devtools',
    envNames: ['WEBFLOW_API_TOKEN'],
    shapes: [],
    mcpUrl: 'https://mcp.webflow.com/sse',
    docsUrl: 'https://developers.webflow.com/data/reference/authentication'
  },
  {
    id: 'wix',
    label: 'Wix',
    category: 'devtools',
    envNames: ['WIX_API_KEY'],
    shapes: [],
    mcpUrl: 'https://mcp.wix.com/sse',
    docsUrl: 'https://manage.wix.com/account/api-keys'
  },
  {
    id: 'atlassian',
    label: 'Jira and Confluence',
    category: 'devtools',
    envNames: ['JIRA_API_TOKEN', 'ATLASSIAN_API_TOKEN', 'CONFLUENCE_API_TOKEN'],
    shapes: [{ prefix: 'ATATT', label: 'API token' }],
    mcpUrl: 'https://mcp.atlassian.com/v1/sse',
    docsUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens'
  },
  {
    id: 'asana',
    label: 'Asana',
    category: 'devtools',
    envNames: ['ASANA_ACCESS_TOKEN', 'ASANA_TOKEN'],
    shapes: [],
    mcpUrl: 'https://mcp.asana.com/v2/mcp',
    docsUrl: 'https://app.asana.com/0/my-apps'
  },
  {
    id: 'clickup',
    label: 'ClickUp',
    category: 'devtools',
    envNames: ['CLICKUP_API_TOKEN', 'CLICKUP_API_KEY'],
    shapes: [],
    mcpUrl: 'https://mcp.clickup.com/mcp',
    docsUrl: 'https://app.clickup.com/settings/apps'
  },
  {
    id: 'monday',
    label: 'monday.com',
    category: 'devtools',
    envNames: ['MONDAY_API_TOKEN', 'MONDAY_API_KEY'],
    shapes: [],
    mcpUrl: 'https://mcp.monday.com/mcp',
    docsUrl: 'https://developer.monday.com/api-reference/docs/authentication'
  },
  {
    id: 'todoist',
    label: 'Todoist',
    category: 'devtools',
    envNames: ['TODOIST_API_TOKEN'],
    shapes: [],
    mcpUrl: 'https://ai.todoist.net/mcp',
    docsUrl: 'https://app.todoist.com/app/settings/integrations/developer'
  },
  {
    id: 'stripe',
    label: 'Stripe',
    category: 'payments',
    envNames: ['STRIPE_SECRET_KEY', 'STRIPE_API_KEY', 'STRIPE_WEBHOOK_SECRET'],
    shapes: [
      { prefix: 'sk_live_', label: 'live secret' },
      { prefix: 'sk_test_', label: 'test secret' },
      { prefix: 'rk_live_', label: 'live restricted' },
      { prefix: 'rk_test_', label: 'test restricted' },
      { prefix: 'whsec_', label: 'webhook secret' }
    ],
    cli: { bin: 'stripe', probe: ['config', '--list'], loginHint: 'stripe login' },
    api: { url: 'https://api.stripe.com/v1/balance', alsoValid: 'required permissions' },
    mcp: ['stripe'],
    mcpUrl: 'https://mcp.stripe.com',
    docsUrl: 'https://dashboard.stripe.com/apikeys'
  },
  {
    id: 'paypal',
    label: 'PayPal',
    category: 'payments',
    envNames: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'],
    shapes: [],
    mcpUrl: 'https://mcp.paypal.com/mcp',
    docsUrl: 'https://developer.paypal.com/dashboard/applications'
  },
  {
    id: 'square',
    label: 'Square',
    category: 'payments',
    envNames: ['SQUARE_ACCESS_TOKEN'],
    shapes: [{ prefix: 'sq0atp-', label: 'access token' }],
    mcpUrl: 'https://mcp.squareup.com/sse',
    docsUrl: 'https://developer.squareup.com/apps'
  },
  {
    id: 'revenuecat',
    label: 'RevenueCat',
    category: 'payments',
    envNames: ['REVENUECAT_SECRET', 'REVENUECAT_SECRET_KEY', 'REVENUECAT_API_KEY'],
    shapes: [
      { prefix: 'sk_', label: 'secret' },
      { prefix: 'appl_', label: 'Apple public' },
      { prefix: 'goog_', label: 'Google public' }
    ],
    api: { url: 'https://api.revenuecat.com/v2/projects' },
    mcpUrl: 'https://mcp.revenuecat.ai/mcp',
    docsUrl: 'https://app.revenuecat.com/settings/api-keys'
  },
  {
    id: 'shopify',
    label: 'Shopify',
    category: 'commerce',
    envNames: ['SHOPIFY_ACCESS_TOKEN', 'SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET'],
    shapes: [
      { prefix: 'shpat_', label: 'admin token' },
      { prefix: 'shpss_', label: 'shared secret' },
      { prefix: 'shpca_', label: 'custom app token' }
    ],
    docsUrl: 'https://partners.shopify.com'
  },
  {
    id: 'amplitude',
    label: 'Amplitude',
    category: 'analytics',
    envNames: ['AMPLITUDE_API_KEY', 'AMPLITUDE_SECRET_KEY'],
    shapes: [],
    mcp: ['Amplitude'],
    mcpUrl: 'https://mcp.amplitude.com/mcp',
    docsUrl: 'https://amplitude.com/get-started'
  },
  {
    id: 'clarity',
    label: 'Microsoft Clarity',
    category: 'analytics',
    envNames: ['CLARITY_API_TOKEN'],
    shapes: [],
    docsUrl: 'https://clarity.microsoft.com'
  },
  {
    id: 'datadog',
    label: 'Datadog',
    category: 'analytics',
    envNames: ['DD_API_KEY', 'DD_APP_KEY'],
    shapes: [],
    docsUrl: 'https://app.datadoghq.com/organization-settings/api-keys'
  },
  {
    id: 'google-analytics',
    label: 'Google Analytics',
    category: 'analytics',
    envNames: ['GA_MEASUREMENT_ID', 'GA_API_SECRET'],
    shapes: [],
    docsUrl: 'https://analytics.google.com/analytics/web/'
  },
  {
    id: 'mixpanel',
    label: 'Mixpanel',
    category: 'analytics',
    envNames: ['MIXPANEL_TOKEN'],
    shapes: [],
    mcpUrl: 'https://mcp.mixpanel.com/mcp',
    docsUrl: 'https://mixpanel.com/settings/project'
  },
  {
    id: 'posthog',
    label: 'PostHog',
    category: 'analytics',
    envNames: ['POSTHOG_API_KEY'],
    shapes: [
      { prefix: 'phc_', label: 'project key' },
      { prefix: 'phx_', label: 'personal key' }
    ],
    mcpUrl: 'https://mcp.posthog.com/mcp',
    docsUrl: 'https://app.posthog.com/project/settings'
  },
  {
    id: 'nango',
    label: 'Nango',
    category: 'devtools',
    envNames: ['NANGO_SECRET_KEY'],
    shapes: [],
    docsUrl: 'https://app.nango.dev/environment-settings'
  },
  {
    id: 'postsyncer',
    label: 'PostSyncer',
    category: 'social',
    envNames: ['POSTSYNCER_TOKEN'],
    shapes: [],
    mcp: ['postsyncer'],
    mcpUrl: 'https://postsyncer.com/mcp',
    docsUrl: 'https://postsyncer.com'
  },
  {
    id: 'turnstile',
    label: 'Cloudflare Turnstile',
    category: 'devtools',
    envNames: ['TURNSTILE_SECRET_KEY'],
    shapes: [{ prefix: '0x4AAA', label: 'secret key' }],
    docsUrl: 'https://dash.cloudflare.com/?to=/:account/turnstile'
  },
  {
    id: 'meta-ads',
    label: 'Meta Ads',
    category: 'ads',
    envNames: ['META_ADS_TOKEN', 'META_ACCESS_TOKEN'],
    shapes: [{ prefix: 'EAA', label: 'user access token' }],
    mcp: ['meta-ads'],
    expiresDays: 60,
    mcpUrl: 'https://mcp.facebook.com/ads',
    docsUrl: 'https://business.facebook.com/adsmanager'
  },
  {
    id: 'slack',
    label: 'Slack',
    category: 'messaging',
    envNames: ['SLACK_BOT_TOKEN', 'SLACK_WEBHOOK_URL', 'SLACK_ADS_WEBHOOK_URL'],
    shapes: [
      { prefix: 'xoxb-', label: 'bot token' },
      { prefix: 'xoxp-', label: 'user token' },
      { prefix: 'xapp-', label: 'app token' },
      { prefix: 'https://hooks.slack.com/', label: 'webhook URL' }
    ],
    mcpUrl: 'https://mcp.slack.com/mcp',
    docsUrl: 'https://api.slack.com/apps'
  },
  {
    id: 'intercom',
    label: 'Intercom',
    category: 'messaging',
    envNames: ['INTERCOM_ACCESS_TOKEN'],
    shapes: [],
    mcpUrl: 'https://mcp.intercom.com/mcp',
    docsUrl: 'https://developers.intercom.com/docs/build-an-integration/learn-more/authentication'
  },
  {
    id: 'discord',
    label: 'Discord',
    category: 'messaging',
    envNames: ['DISCORD_BOT_TOKEN', 'DISCORD_WEBHOOK_URL'],
    shapes: [],
    docsUrl: 'https://discord.com/developers/applications'
  },
  {
    id: 'telegram',
    label: 'Telegram',
    category: 'messaging',
    envNames: ['TELEGRAM_BOT_TOKEN'],
    shapes: [],
    docsUrl: 'https://my.telegram.org/apps'
  },
  {
    id: 'twilio',
    label: 'Twilio',
    category: 'messaging',
    envNames: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
    shapes: [{ prefix: 'AC', label: 'account SID' }],
    docsUrl: 'https://console.twilio.com'
  },
  {
    id: 'resend',
    label: 'Resend',
    category: 'email',
    envNames: ['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET'],
    shapes: [{ prefix: 're_', label: 'API key' }],
    api: { url: 'https://api.resend.com/domains', alsoValid: 'restricted_api_key' },
    mcpUrl: 'https://mcp.resend.com/mcp',
    docsUrl: 'https://resend.com/api-keys'
  },
  {
    id: 'sendgrid',
    label: 'SendGrid',
    category: 'email',
    envNames: ['SENDGRID_API_KEY'],
    shapes: [{ prefix: 'SG.', label: 'API key' }],
    docsUrl: 'https://app.sendgrid.com/settings/api_keys'
  },
  {
    id: 'mailgun',
    label: 'Mailgun',
    category: 'email',
    envNames: ['MAILGUN_API_KEY'],
    shapes: [],
    docsUrl: 'https://app.mailgun.com/app/account/security/api_keys'
  },
  {
    id: 'brevo',
    label: 'Brevo',
    category: 'email',
    envNames: ['BREVO_API_KEY'],
    shapes: [],
    docsUrl: 'https://app.brevo.com/settings/keys/api'
  },
  {
    id: 'mailchimp',
    label: 'Mailchimp',
    category: 'email',
    envNames: ['MAILCHIMP_API_KEY'],
    shapes: [],
    docsUrl: 'https://mailchimp.com/help/about-api-keys/'
  },
  {
    id: 'postmark',
    label: 'Postmark',
    category: 'email',
    envNames: ['POSTMARK_SERVER_TOKEN'],
    shapes: [],
    docsUrl: 'https://account.postmarkapp.com/api_tokens'
  },
  {
    id: 'beehiiv',
    label: 'beehiiv',
    category: 'email',
    envNames: ['BEEHIIV_API_KEY'],
    shapes: [],
    docsUrl: 'https://www.beehiiv.com/settings/integrations'
  },
  {
    id: 'klaviyo',
    label: 'Klaviyo',
    category: 'email',
    envNames: ['KLAVIYO_API_KEY', 'KLAVIYO_PRIVATE_KEY'],
    shapes: [],
    mcpUrl: 'https://mcp.klaviyo.com/mcp',
    docsUrl: 'https://www.klaviyo.com/settings/account/api-keys'
  },
  {
    id: 'zoho',
    label: 'Zoho',
    category: 'email',
    envNames: ['ZOHO_REFRESH_TOKEN', 'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET'],
    shapes: [],
    mcp: ['zoho-mail'],
    docsUrl: 'https://mail.zoho.com/zm/#settings/appPasswords'
  },
  {
    id: 'facebook',
    label: 'Facebook',
    category: 'social',
    envNames: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
    shapes: [],
    docsUrl: 'https://developers.facebook.com/apps'
  },
  {
    id: 'hubspot',
    label: 'HubSpot',
    category: 'social',
    envNames: ['HUBSPOT_API_KEY'],
    shapes: [{ prefix: 'pat-', label: 'private app token' }],
    mcpUrl: 'https://mcp.hubspot.com',
    docsUrl: 'https://developers.hubspot.com/docs/api/private-apps'
  },
  {
    id: 'gohighlevel',
    label: 'HighLevel',
    category: 'social',
    envNames: ['GHL_API_KEY', 'HIGHLEVEL_API_KEY'],
    shapes: [{ prefix: 'pit-', label: 'private integration token' }],
    mcpUrl: 'https://services.leadconnectorhq.com/mcp/',
    docsUrl: 'https://marketplace.gohighlevel.com/docs/'
  },
  {
    id: 'instagram',
    label: 'Instagram',
    category: 'social',
    envNames: ['INSTAGRAM_ACCESS_TOKEN'],
    shapes: [],
    docsUrl: 'https://developers.facebook.com/docs/instagram'
  },
  {
    id: 'reddit',
    label: 'Reddit',
    category: 'social',
    envNames: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
    shapes: [],
    docsUrl: 'https://www.reddit.com/prefs/apps'
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    category: 'social',
    envNames: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
    shapes: [],
    docsUrl: 'https://developers.tiktok.com'
  },
  {
    id: 'x',
    label: 'X',
    category: 'social',
    envNames: ['X_API_KEY', 'TWITTER_BEARER_TOKEN'],
    shapes: [],
    docsUrl: 'https://developer.x.com/en/portal/dashboard'
  },
  {
    id: 'youtube',
    label: 'YouTube',
    category: 'social',
    envNames: ['YOUTUBE_API_KEY'],
    shapes: [],
    docsUrl: 'https://developers.google.com/youtube/registering_an_application'
  }
]

export function keyProvider(id: string): KeyProvider | undefined {
  return KEY_PROVIDERS.find((p) => p.id === id)
}
