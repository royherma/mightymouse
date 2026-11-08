import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { AgentOrigin } from '../../shared/types'
import { resolveBinary } from '../platform/macos/resolve-binary'

const LOOKUP_TIMEOUT_MS = 3000
const COMMAND_TIMEOUT_MS = 3000
const RECONNECT_MS = 1000
const MAX_RECONNECTS = 5

type Reply = { resolve: (out: string | null) => void; timer: ReturnType<typeof setTimeout> }

function quote(arg: string): string {
  return /^[\w%@$.:/=+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

class ControlClient {
  private proc: ChildProcessWithoutNullStreams
  private buf = ''
  private block: string[] | null = null
  private replies: Reply[] = []
  closed = false

  constructor(
    tmux: string,
    socket: string[],
    session: string,
    private on: { output: (pane: string) => void; layout: () => void; exit: () => void }
  ) {
    // ignore-size: without it this hidden client would resize the panes the user has open in cmux.
    this.proc = spawn(tmux, [...socket, '-C', 'attach-session', '-t', session, '-f', 'ignore-size'])
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.read(chunk))
    this.proc.stderr.resume()
    this.proc.on('error', () => this.close())
    this.proc.on('exit', () => this.close())
  }

  private read(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      this.line(this.buf.slice(0, nl))
      this.buf = this.buf.slice(nl + 1)
    }
  }

  private line(line: string): void {
    if (this.block) {
      if (/^%(end|error) \d+ \d+ 1$/.test(line)) {
        const out = line.startsWith('%end') ? this.block.join('\n') : null
        this.block = null
        const reply = this.replies.shift()
        if (reply) {
          clearTimeout(reply.timer)
          reply.resolve(out)
        }
      } else this.block.push(line)
      return
    }
    // Flag 1 marks a reply to our own command; the attach answers with flag 0.
    if (/^%begin \d+ \d+ 1$/.test(line)) this.block = []
    else if (line.startsWith('%output ')) this.on.output(line.slice(8, line.indexOf(' ', 8)))
    else if (line.startsWith('%layout-change ') || line.startsWith('%window-pane-changed ')) this.on.layout()
    else if (line === '%exit' || line.startsWith('%exit ')) this.close()
  }

  command(args: string[]): Promise<string | null> {
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(null)
        this.close()
      }, COMMAND_TIMEOUT_MS)
      this.replies.push({ resolve, timer })
      this.proc.stdin.write(`${args.map(quote).join(' ')}\n`)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const r of this.replies.splice(0)) {
      clearTimeout(r.timer)
      r.resolve(null)
    }
    this.proc.stdin.end()
    if (this.proc.exitCode === null) this.proc.kill()
    this.on.exit()
  }
}

type Watched = {
  origin: AgentOrigin
  fns: Set<() => void>
  key: string | null
  fails: number
  retry?: ReturnType<typeof setTimeout>
}

const clients = new Map<string, ControlClient>()
const watched = new Map<string, Watched>()

const socketArgs = (origin: AgentOrigin): string[] => (origin.tmuxSocket ? ['-S', origin.tmuxSocket] : [])

function notify(pane: string): void {
  watched.get(pane)?.fns.forEach((fn) => fn())
}

function panesOn(key: string): string[] {
  return [...watched].filter(([, w]) => w.key === key).map(([pane]) => pane)
}

function sessionOf(tmux: string, origin: AgentOrigin): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      tmux,
      [...socketArgs(origin), 'display-message', '-p', '-t', origin.tmuxPane!, '#{session_id}'],
      { timeout: LOOKUP_TIMEOUT_MS },
      (err, out) => resolve(err ? null : out.trim() || null)
    )
  })
}

function clientFor(tmux: string, origin: AgentOrigin, session: string): string {
  const key = `${origin.tmuxSocket ?? ''}|${session}`
  if (clients.get(key)?.closed === false) return key
  clients.set(
    key,
    new ControlClient(tmux, socketArgs(origin), session, {
      output: notify,
      layout: () => panesOn(key).forEach(notify),
      exit: () => {
        if (clients.get(key)?.closed) clients.delete(key)
        for (const pane of panesOn(key)) {
          watched.get(pane)!.key = null
          notify(pane)
          retryLater(pane)
        }
      }
    })
  )
  return key
}

async function connect(pane: string): Promise<void> {
  const tmux = resolveBinary('tmux')
  const w = watched.get(pane)
  if (!tmux || !w) return
  const session = await sessionOf(tmux, w.origin)
  if (watched.get(pane) !== w) return
  if (!session) return retryLater(pane)
  w.key = clientFor(tmux, w.origin, session)
  w.fails = 0
  notify(pane)
}

function retryLater(pane: string): void {
  const w = watched.get(pane)
  if (!w || w.retry || ++w.fails > MAX_RECONNECTS) return
  w.retry = setTimeout(() => {
    w.retry = undefined
    void connect(pane)
  }, RECONNECT_MS)
}

export function watchPane(origin: AgentOrigin | undefined, onChange: () => void): () => void {
  const pane = origin?.tmuxPane
  if (!origin || !pane) return () => {}
  let w = watched.get(pane)
  if (!w) {
    w = { origin, fns: new Set(), key: null, fails: 0 }
    watched.set(pane, w)
    void connect(pane)
  }
  w.fns.add(onChange)
  return () => {
    w.fns.delete(onChange)
    if (w.fns.size > 0 || watched.get(pane) !== w) return
    clearTimeout(w.retry)
    watched.delete(pane)
    if (w.key && panesOn(w.key).length === 0) {
      const client = clients.get(w.key)
      clients.delete(w.key)
      client?.close()
    }
  }
}

export function streamCommand(origin: AgentOrigin | undefined): ((args: string[]) => Promise<string | null>) | null {
  const key = origin?.tmuxPane ? watched.get(origin.tmuxPane)?.key : null
  const client = key ? clients.get(key) : undefined
  return client && !client.closed ? (args) => client.command(args) : null
}

export function isStreaming(origin: AgentOrigin | undefined): boolean {
  return streamCommand(origin) !== null
}
