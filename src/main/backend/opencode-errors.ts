const OPENCODE_ACCOUNTS: Record<string, { name: string; credit: string; privacy: string }> = {
  openrouter: {
    name: 'OpenRouter',
    credit: 'https://openrouter.ai/settings/credits',
    privacy: 'https://openrouter.ai/settings/privacy'
  },
  opencode: { name: 'OpenCode Zen', credit: 'https://opencode.ai/zen', privacy: 'https://opencode.ai/zen' },
  'opencode-go': { name: 'OpenCode Go', credit: 'https://opencode.ai/zen', privacy: 'https://opencode.ai/zen' }
}

export function opencodeProblem(model: string, error: string): string {
  const id = model.split('/')[0]
  const account = OPENCODE_ACCOUNTS[id] ?? { name: id || 'model provider', credit: '', privacy: '' }
  const lead = account.name[0].toUpperCase() + account.name.slice(1)
  const at = (url: string): string => (url ? ` at ${url}` : '')
  if (/user not found|unauthori[sz]ed|invalid api key|401/i.test(error))
    return `${lead} didn't accept your saved key. Run "opencode auth login" in a terminal and paste a new one.`
  if (/insufficient|funds|credits?\b/i.test(error)) return `Your ${account.name} account is out of credit. Top up${at(account.credit)}.`
  if (/trains? on request data|model training|data policy/i.test(error))
    return `This model learns from what you send it, and your ${account.name} privacy settings block that. Allow it${at(account.privacy)}, or pick the version without "contributor".`
  return `${lead} said: ${error}`
}

export function opencodeErrorEvent(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    try {
      const e = JSON.parse(line) as { type?: string; error?: { data?: { message?: unknown }; name?: unknown } }
      if (e.type !== 'error') continue
      const message = e.error?.data?.message ?? e.error?.name
      return typeof message === 'string' ? message : 'unknown error'
    } catch {
      continue
    }
  }
  return null
}
