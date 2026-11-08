import type { FactoryArea } from './factory'
import {
  BUSINESS_LABELS,
  GOAL_LIVE,
  briefSentence,
  type BusinessType,
  type ProjectBrief
} from './infra'
import type { ReportBetter, ReportUnit } from './reports'
import PLAYBOOK_DATA from './playbooks.json'

export interface Benchmark {
  value: number
  group: string
  by: string
  url: string
  year?: number
  sample?: string
  niche?: string
  top?: number
}

export interface BusinessMetric {
  id: string
  label: string
  what: string
  typical?: string
  source?: string
  unit?: ReportUnit
  better?: ReportBetter
  benchmarks?: Benchmark[]
}

export const PLAYBOOK_USES = {
  win: 'Win more customers',
  keep: 'Keep customers',
  found: 'Get found',
  fast: 'Faster, fewer errors',
  numbers: 'See your numbers'
} as const
export type PlaybookUse = keyof typeof PLAYBOOK_USES

const NO_NEW_TOOLS = 'Work with what this project already uses. Do not add a paid tool or service unless I ask for one.'

export interface Playbook {
  id: string
  title: string
  benefit: string
  moves: string
  use: PlaybookUse
  area: FactoryArea
  tags: string[]
  goal: string
  steps: string[]
  publisher: { name: string; url: string }
  source?: { name: string; url: string; sells?: string }
  added: string
  checked: string
}

export type PlaybookRecord = Playbook & { kind: BusinessType; status: string }

export const PLAYBOOK_LIBRARY = (PLAYBOOK_DATA as PlaybookRecord[]).filter((p) => p.status === 'live')
export const PLAYBOOK_PAGES = 'https://getmightymouse.com/playbooks'

const sourceHost = (playbook: Playbook): string | undefined => playbook.source && new URL(playbook.source.url).host.replace(/^www\./, '')

export function playbookPicture(playbook: Playbook): string {
  const host = sourceHost(playbook)
  return host ? `/playbook-img/sources/${host}.jpg` : `/playbook-img/covers/${playbook.id}.jpg`
}

export function playbookSourceIcon(playbook: Playbook): string | undefined {
  const host = sourceHost(playbook)
  return host && `/playbook-img/icons/${host}.png`
}

function playbooksOf(kind: BusinessType): Playbook[] {
  return PLAYBOOK_LIBRARY.filter((p) => p.kind === kind)
}

const POLAR = {
  by: 'Polar Analytics',
  year: 2026,
  sample: '4,000+ stores',
  url: 'https://www.polaranalytics.com/ecommerce-benchmarks'
}

// niche, group, visitors who buy %, average order $, add to cart %
const STORE_NICHES: [string, string, number, number, number][] = [
  ['Clothing and accessories', 'clothing stores', 2.02, 82.5, 7.37],
  ['Arts and entertainment', 'arts and entertainment stores', 2.75, 93.8, 7.64],
  ['Automotive', 'automotive stores', 1.43, 122.1, 10.88],
  ['Beauty and personal care', 'beauty stores', 2.74, 66, 18.18],
  ['Business and industrial', 'business supply stores', 1.66, 340.21, 9.26],
  ['Electronics', 'electronics stores', 1.74, 135.6, 8.85],
  ['Food and drink', 'food and drink stores', 3, 76.43, 12.54],
  ['Gifts', 'gift stores', 2.28, 84.04, 10.91],
  ['Health and wellness', 'health stores', 2.74, 66, 12.91],
  ['Home and garden', 'home and garden stores', 1.82, 121, 8.65],
  ['Pet supplies', 'pet stores', 2.7, 64.9, 15.26],
  ['General retail', 'general retail stores', 2.61, 82.04, 14.83],
  ['Sports and outdoor', 'sports and outdoor stores', 2.25, 138.48, 7.62],
  ['Toys and hobbies', 'toy and hobby stores', 1.49, 98.72, 7.54]
]

function storeNiches(column: 2 | 3 | 4): Benchmark[] {
  return STORE_NICHES.map((row) => ({ ...POLAR, niche: row[0], group: row[1], value: row[column] }))
}

const UNBOUNCE = {
  by: 'Unbounce',
  year: 2024,
  sample: '41,000 pages',
  url: 'https://unbounce.com/landing-pages/whats-a-good-conversion-rate/'
}

const LANDING_NICHES: [string, string, number][] = [
  ['Online store', 'store landing pages', 4.2],
  ['Software', 'software landing pages', 3.8],
  ['Professional services', 'professional services pages', 6.1],
  ['Legal', 'legal landing pages', 6.3],
  ['Finance', 'finance landing pages', 8.3],
  ['Education', 'education landing pages', 8.4],
  ['Travel', 'travel landing pages', 4.8],
  ['Entertainment', 'entertainment landing pages', 12.3]
]

const REVENUECAT = {
  by: 'RevenueCat',
  year: 2026,
  url: 'https://www.revenuecat.com/state-of-subscription-apps/'
}

export const BUSINESS_PLAYBOOKS: Record<
  BusinessType,
  { metrics: BusinessMetric[]; playbooks: Playbook[] }
> = {
  store: {
    metrics: [
      {
        id: 'store.visitors-who-buy',
        label: 'Visitors who buy',
        what: 'Orders divided by store visits, as a percent.',
        typical: '2.66% is the global average',
        source: 'https://www.shopify.com/blog/ecommerce-conversion-rate',
        unit: 'percent',
        better: 'up',
        benchmarks: [
          {
            value: 2.66,
            group: 'online stores',
            by: 'Shopify',
            year: 2026,
            url: 'https://www.shopify.com/blog/ecommerce-conversion-rate'
          },
          ...storeNiches(2)
        ]
      },
      {
        id: 'store.carts-left-behind',
        label: 'Carts left behind',
        what: 'Share of shoppers who add to cart but never finish paying.',
        typical: '70.22% is the documented average',
        source: 'https://baymard.com/lists/cart-abandonment-rate',
        unit: 'percent',
        better: 'down',
        benchmarks: [
          {
            value: 70.22,
            group: 'online stores',
            by: 'Baymard Institute',
            sample: '50 studies',
            url: 'https://baymard.com/lists/cart-abandonment-rate'
          }
        ]
      },
      {
        id: 'store.main-image-load-time',
        label: 'Main image load time',
        what: 'Seconds until the biggest thing on a product page (usually the hero image) appears, measured as Largest Contentful Paint.',
        typical: '2.5 seconds or less is good, at the 75th percentile of visits',
        source: 'https://web.dev/articles/vitals'
      },
      {
        id: 'store.average-order-value',
        label: 'Average order value',
        what: 'Total revenue divided by number of orders.',
        source: POLAR.url,
        unit: 'usd',
        better: 'up',
        benchmarks: storeNiches(3)
      },
      {
        id: 'store.visitors-who-add-to-cart',
        label: 'Visitors who add to cart',
        what: 'Visits where something went into the cart, divided by all visits.',
        source: POLAR.url,
        unit: 'percent',
        better: 'up',
        benchmarks: storeNiches(4)
      }
    ],
    playbooks: playbooksOf('store')
  },
  saas: {
    metrics: [
      {
        id: 'saas.visitors-who-sign-up',
        label: 'Visitors who sign up',
        what: 'New accounts divided by visits to the signup page.'
      },
      {
        id: 'saas.signups-who-reach-value',
        label: 'Signups who reach value',
        what: 'Share of new accounts that complete the key first action (the moment the product proves itself) within a week.'
      },
      {
        id: 'saas.customers-who-cancel',
        label: 'Customers who cancel',
        what: 'Customers lost in a period divided by customers at the start of it.',
        typical: '3.04% a year is the median for software on Recurly',
        source: 'https://recurly.com/research/churn-rate-benchmarks/'
      },
      {
        id: 'saas.cancels-from-failed-payments',
        label: 'Cancels from failed payments',
        what: 'Customers lost because a card payment failed, as a share of all customers lost.',
        typical: '1.06 of 3.22 points of yearly churn come from failed payments (Recurly)',
        source: 'https://recurly.com/research/churn-rate-benchmarks/'
      }
    ],
    playbooks: playbooksOf('saas')
  },
  app: {
    metrics: [
      {
        id: 'app.downloads-that-pay',
        label: 'Downloads that pay',
        what: 'Share of new installs that become paying subscribers within 35 days.',
        typical: 'by day 35 the median is 2.1% for free-to-start apps and 10.7% for pay-first apps',
        source: 'https://www.revenuecat.com/state-of-subscription-apps/',
        unit: 'percent',
        better: 'up',
        benchmarks: [{ ...REVENUECAT, value: 2.1, group: 'apps that are free to start', top: 10.7 }]
      },
      {
        id: 'app.trials-that-become-paid',
        label: 'Trials that become paid',
        what: 'Share of free trials that turn into a paid subscription.',
        typical: '42.5% for trials of 17+ days, 25.5% for short trials',
        source: 'https://www.revenuecat.com/state-of-subscription-apps/',
        unit: 'percent',
        better: 'up',
        benchmarks: [{ ...REVENUECAT, value: 25.5, group: 'apps with a trial of 4 days or less' }]
      },
      {
        id: 'app.users-back-next-day',
        label: 'Users back next day',
        what: 'Share of new users who open the app again the day after install.'
      },
      {
        id: 'app.crash-free-sessions',
        label: 'Crash-free sessions',
        what: 'Share of app sessions that end without a crash.'
      }
    ],
    playbooks: playbooksOf('app')
  },
  marketplace: {
    metrics: [
      {
        id: 'marketplace.browsers-who-buy',
        label: 'Browsers who buy',
        what: 'Buyers who complete a purchase divided by buyers who searched or browsed listings.',
        typical: '30 to 60% is a good goal',
        source: 'https://www.sharetribe.com/academy/measure-your-success-key-marketplace-metrics/'
      },
      {
        id: 'marketplace.listings-that-sell',
        label: 'Listings that sell',
        what: 'Share of active listings that get at least one sale in a period.'
      },
      {
        id: 'marketplace.sellers-who-list-again',
        label: 'Sellers who list again',
        what: 'Sellers who post a second listing divided by sellers who posted a first.'
      },
      {
        id: 'marketplace.share-we-keep-per-sale',
        label: 'Share we keep per sale',
        what: 'Fees earned divided by total value of sales (take rate).'
      }
    ],
    playbooks: playbooksOf('marketplace')
  },
  extension: {
    metrics: [
      {
        id: 'extension.installs-that-stay',
        label: 'Installs that stay',
        what: 'Share of installs still installed after 7 days (installs minus uninstalls).'
      },
      {
        id: 'extension.weekly-active-users',
        label: 'Weekly active users',
        what: 'People who use the extension at least once a week.'
      },
      {
        id: 'extension.store-rating',
        label: 'Store rating',
        what: 'Average star rating on the Chrome Web Store listing.'
      }
    ],
    playbooks: playbooksOf('extension')
  },
  devtool: {
    metrics: [
      {
        id: 'devtool.minutes-to-first-success',
        label: 'Minutes to first success',
        what: 'Time from landing on the docs to a first working API call or command (time to first call).'
      },
      {
        id: 'devtool.installs-that-get-used',
        label: 'Installs that get used',
        what: 'Share of package installs or API keys that make at least one real call within a week.'
      },
      {
        id: 'devtool.docs-blockers',
        label: 'Docs blockers',
        what: 'Count of support questions or issues that the docs should have answered.'
      },
      {
        id: 'devtool.error-rate-on-calls',
        label: 'Error rate on calls',
        what: 'Failed requests divided by all requests.'
      }
    ],
    playbooks: playbooksOf('devtool')
  },
  content: {
    metrics: [
      {
        id: 'content.pages-that-get-search-visits',
        label: 'Pages that get search visits',
        what: 'Share of your published pages that received at least one visit from Google last month.',
        typical: '96.55% of all pages get zero visits from Google',
        source: 'https://ahrefs.com/blog/search-traffic-study/'
      },
      {
        id: 'content.readers-who-subscribe',
        label: 'Readers who subscribe',
        what: 'New subscribers divided by unique readers.'
      },
      {
        id: 'content.article-load-time',
        label: 'Article load time',
        what: 'Seconds until the main headline or image appears (Largest Contentful Paint).',
        typical: '2.5 seconds or less is good, at the 75th percentile of visits',
        source: 'https://web.dev/articles/vitals'
      },
      {
        id: 'content.pages-that-shift-while-loading',
        label: 'Pages that shift while loading',
        what: 'Layout jump score (Cumulative Layout Shift) as the page loads, from ads, images and fonts.',
        typical: '0.1 or less is good',
        source: 'https://web.dev/articles/vitals'
      }
    ],
    playbooks: playbooksOf('content')
  },
  landing: {
    metrics: [
      {
        id: 'landing.visitors-who-sign-up',
        label: 'Visitors who sign up',
        what: 'Signups or leads divided by visits to the page.',
        typical: '6.6% is the median across industries',
        source: 'https://unbounce.com/average-conversion-rates-landing-pages/',
        unit: 'percent',
        better: 'up',
        benchmarks: [
          { ...UNBOUNCE, value: 6.6, group: 'landing pages' },
          ...LANDING_NICHES.map(([niche, group, value]) => ({
            ...UNBOUNCE,
            niche,
            group,
            value,
            ...(niche === 'Online store' ? { top: 11.4 } : {})
          }))
        ]
      },
      {
        id: 'landing.page-load-time',
        label: 'Page load time',
        what: 'Seconds until the main headline or hero appears (Largest Contentful Paint).',
        typical: '2.5 seconds or less is good, at the 75th percentile of visits',
        source: 'https://web.dev/articles/vitals'
      },
      {
        id: 'landing.form-completion-rate',
        label: 'Form completion rate',
        what: 'People who submit the form divided by people who start it.'
      }
    ],
    playbooks: playbooksOf('landing')
  },
  internal: {
    metrics: [
      {
        id: 'internal.weekly-active-teammates',
        label: 'Weekly active teammates',
        what: 'Distinct people who used the tool in the last 7 days divided by people who should.'
      },
      {
        id: 'internal.time-to-finish-the-job',
        label: 'Time to finish the job',
        what: 'Minutes a teammate takes to complete the task the tool exists for.'
      },
      {
        id: 'internal.shipping-speed',
        label: 'Shipping speed',
        what: 'Time for a change to go from committed to live (change lead time).'
      },
      {
        id: 'internal.errors-people-hit',
        label: 'Errors people hit',
        what: 'Failed page loads or actions per week from error logs.'
      }
    ],
    playbooks: playbooksOf('internal')
  }
}

const ALL_TYPES = Object.keys(BUSINESS_PLAYBOOKS) as BusinessType[]

export function metricById(id: string | undefined): BusinessMetric | undefined {
  if (!id) return undefined
  for (const type of ALL_TYPES) {
    const metric = BUSINESS_PLAYBOOKS[type].metrics.find((m) => m.id === id)
    if (metric) return metric
  }
  return undefined
}

export function typicalFor(metric: BusinessMetric, niche?: string): Benchmark | undefined {
  const wanted = niche?.trim().toLowerCase()
  const list = metric.benchmarks ?? []
  return (
    (wanted ? list.find((b) => b.niche?.toLowerCase() === wanted) : undefined) ??
    list.find((b) => !b.niche)
  )
}

export function nichesFor(types: BusinessType[]): string[] {
  const names = types.flatMap((type) =>
    BUSINESS_PLAYBOOKS[type].metrics.flatMap((m) => (m.benchmarks ?? []).map((b) => b.niche))
  )
  return [...new Set(names.filter((n): n is string => !!n))]
}

export function typicalText(metric: BusinessMetric, value: number): string {
  const n = String(Math.round(value * 100) / 100)
  return metric.unit === 'usd' ? `$${n}` : metric.unit === 'percent' ? `${n}%` : n
}

export function benchmarkSource(b: Benchmark): string {
  return [b.by, b.year, b.sample].filter(Boolean).join(', ')
}

function metricLine(m: BusinessMetric, niche?: string): string {
  const found = typicalFor(m, niche)
  const typical = found?.niche
    ? ` Typical for ${found.group}: ${typicalText(m, found.value)}.`
    : m.typical
      ? ` Typical: ${m.typical}.`
      : found
        ? ` Typical for ${found.group}: ${typicalText(m, found.value)}.`
        : ''
  return `${m.label} (${m.what}${typical})`
}

const USE_AREAS: Record<PlaybookUse, FactoryArea[]> = {
  win: ['marketing', 'sales', 'product'],
  keep: ['customers', 'product'],
  found: ['marketing'],
  fast: ['engineering'],
  numbers: ['data']
}

export function ideasGoal(use: PlaybookUse, types: BusinessType[]): string {
  const plays = types.flatMap((type) => BUSINESS_PLAYBOOKS[type].playbooks.filter((p) => p.use === use))
  const proven = plays.length
    ? ` Proven playbooks for this kind of project, to consider first: ${plays.map((p) => `${p.title} - ${p.goal}`).join(' | ')}.`
    : ''
  return `What the owner wants: ${PLAYBOOK_USES[use].toLowerCase()}. Find the two highest-value, bounded tasks in this project that do that.${proven} Tag every task with one of these areas: ${USE_AREAS[use].join(', ')}. Prefer clear user benefit and work that can be proven. If the project already does this well, return no tasks.`
}

export function playbookGoal(type: BusinessType, playbook: Playbook): string {
  return `Recommended playbook (${BUSINESS_LABELS[type].label}): ${playbook.title}. ${playbook.goal} Propose at most two bounded tasks and tag every task with area ${playbook.area}. If the code already does this well, return no tasks.`
}

function playbookCredit(playbook: PlaybookRecord): string {
  const source = playbook.source ? ` Source: ${playbook.source.name}, ${playbook.source.url}` : ''
  return `Playbook: ${PLAYBOOK_PAGES}/${playbook.id}/ - published by ${playbook.publisher.name}.${source}`
}

export function playbookPrompt(playbook: PlaybookRecord): string {
  return [
    `${playbook.title} (${BUSINESS_LABELS[playbook.kind].label})`,
    playbook.goal,
    `Done when:\n${playbook.steps.map((step) => `- ${step}`).join('\n')}`,
    'Read the code first. If it already does this well, change nothing and say so. Otherwise make the smallest change that makes every line above true.',
    NO_NEW_TOOLS,
    playbookCredit(playbook)
  ].join('\n\n')
}

export function playbookSkill(playbook: PlaybookRecord): string {
  const kind = BUSINESS_LABELS[playbook.kind].label.toLowerCase()
  return [
    `---\nname: ${playbook.id}\ndescription: ${playbook.benefit} Use on a ${kind} project to improve "${playbook.moves}".\n---`,
    `# ${playbook.title}`,
    playbook.goal,
    `## Done when\n\n${playbook.steps.map((step) => `- [ ] ${step}`).join('\n')}`,
    '## How to run it\n\nRead the code first and tick every line that is already true. If all are true, change nothing and say so. Otherwise make the smallest change that makes the rest true, then report each line as done or not done.',
    NO_NEW_TOOLS,
    playbookCredit(playbook)
  ].join('\n\n') + '\n'
}

export function playbookFor(metricId: string): { type: BusinessType; playbook: Playbook } | undefined {
  for (const type of ALL_TYPES) {
    const metric = BUSINESS_PLAYBOOKS[type].metrics.find((m) => m.id === metricId)
    const playbook = metric && BUSINESS_PLAYBOOKS[type].playbooks.find((p) => p.moves === metric.label)
    if (playbook) return { type, playbook }
  }
  return undefined
}

export function goalDay(by: string): string {
  const [year, month, day] = by.split('-').map(Number)
  const name = new Date(Date.UTC(year, month - 1, day)).toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC'
  })
  return `${day} ${name} ${year}`
}

export function goalText(brief: ProjectBrief | undefined): string {
  const goal = brief?.goal
  if (!goal) return ''
  if (goal.metric === GOAL_LIVE) return 'Get it live first'
  const metric = metricById(goal.metric)
  if (!metric) return ''
  const target = goal.target !== undefined ? ` to ${typicalText(metric, goal.target)}` : ''
  return `${metric.label}${target}${goal.by ? ` by ${goalDay(goal.by)}` : ''}`
}

export function projectFacts(types: BusinessType[], brief?: ProjectBrief): string {
  const lines = types.map(
    (type) =>
      `${BUSINESS_LABELS[type].label} (${BUSINESS_LABELS[type].hint}). Numbers that matter: ${BUSINESS_PLAYBOOKS[
        type
      ].metrics
        .map((m) => metricLine(m, brief?.niche))
        .join('; ')}`
  )
  const goal = goalText(brief)
  const parts = [
    briefSentence(brief),
    ...lines,
    ...(goal
      ? [
          brief?.goal?.metric === GOAL_LIVE
            ? 'Goal: get it live first. Prefer the shortest path to a working version people can use.'
            : `Goal: ${goal}. Prefer work that moves that number.`
        ]
      : [])
  ].filter(Boolean)
  return parts.length ? `What this project is: ${parts.join(' ')}` : ''
}

export function businessContext(types: BusinessType[], brief?: ProjectBrief): string {
  const facts = projectFacts(types, brief)
  return facts && `${facts} Prefer tasks that move one of these numbers, and say which one in the outcome.`
}

export function runContext(types: BusinessType[], brief?: ProjectBrief): string {
  const facts = projectFacts(types, brief)
  return facts && `${facts} When the request leaves a choice open, pick what moves one of these numbers.`
}
