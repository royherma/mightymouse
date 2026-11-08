import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  COORDINATION,
  coordinationSchemas,
  registrationSchema,
  type CoordinationArgs,
  type CoordinationOp,
  type CoordinationSession,
  type CoordinationMessage,
  type CoordinationWork,
  type CoordinationEvent,
  type CoordinationProject,
  type CoordinationSnapshot,
  type Registration
} from '../../../shared/coordination'

type SessionRow = Registration & {
  id: string
  tokenHash: string
  lastSeen: number
  state: CoordinationSession['state']
}
type MessageRow = Omit<CoordinationMessage, 'refs'> & {
  refs: string
  requestKey: string
  fingerprint: string
}
type WorkRow = Omit<CoordinationWork, 'refs' | 'expired'> & { refs: string }
type ProjectRow = Omit<CoordinationProject, 'tags'> & { tags: string }
export class CoordinationError extends Error {
  constructor(
    public code: 'invalid' | 'unauthorized' | 'conflict' | 'not_found' | 'backpressure',
    message: string
  ) {
    super(message)
  }
}
const ABANDONED_NOTE =
  'Not delivered: the recipient stopped checking in a day ago. Send it to a live agent.'
const ABANDONED_CLAIM = 'Released: the owner stopped checking in a day ago.'
export const tokenHash =(value: string): string => createHash('sha256').update(value).digest('hex')

export class CoordinationStore {
  private db: Database.Database
  constructor(
    path: string,
    private now: () => number = Date.now
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path)
    this.db.pragma(`busy_timeout = ${COORDINATION.busyTimeoutMs}`)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('foreign_keys = ON')
    if (path !== ':memory:') chmodSync(path, 0o600)
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version > COORDINATION.version) {
      this.db.close()
      throw new CoordinationError(
        'conflict',
        'This work history needs a newer MightyMouse version.'
      )
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, tags TEXT NOT NULL, "order" INTEGER NOT NULL,
        state TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, projectName TEXT NOT NULL,
        session TEXT NOT NULL, harness TEXT NOT NULL, label TEXT NOT NULL, cwd TEXT NOT NULL,
        version TEXT NOT NULL, tokenHash TEXT UNIQUE NOT NULL, lastSeen INTEGER NOT NULL, state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, sender TEXT NOT NULL REFERENCES sessions(id),
        recipient TEXT NOT NULL REFERENCES sessions(id), requestKey TEXT NOT NULL, fingerprint TEXT NOT NULL,
        subject TEXT NOT NULL, body TEXT NOT NULL, refs TEXT NOT NULL, work TEXT,
        state TEXT NOT NULL, note TEXT NOT NULL, createdAt INTEGER NOT NULL, offeredAt INTEGER, updatedAt INTEGER NOT NULL,
        UNIQUE(sender, requestKey)
      );
      CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient, state, createdAt);
      CREATE TABLE IF NOT EXISTS work (
        project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, acceptance TEXT NOT NULL,
        owner TEXT NOT NULL REFERENCES sessions(id), generation INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
        state TEXT NOT NULL, stage TEXT NOT NULL, note TEXT NOT NULL, refs TEXT NOT NULL, updatedAt INTEGER NOT NULL,
        emoji TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(project, id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, actor TEXT NOT NULL,
        kind TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_project ON events(project, seq);
      PRAGMA user_version = ${COORDINATION.version};
    `)
    // CREATE TABLE IF NOT EXISTS leaves an existing database on the old columns.
    const workColumns = this.db.pragma('table_info(work)') as { name: string }[]
    if (!workColumns.some((c) => c.name === 'emoji'))
      this.db.exec(`ALTER TABLE work ADD COLUMN emoji TEXT NOT NULL DEFAULT ''`)
  }

  close(): void {
    this.db.close()
  }
  private event(
    actor: SessionRow,
    kind: string,
    target: string,
    detail: Record<string, unknown> = {}
  ): void {
    this.db
      .prepare('INSERT INTO events(project, actor, kind, target, at, detail) VALUES(?,?,?,?,?,?)')
      .run(actor.project, actor.id, kind, target, this.now(), JSON.stringify(detail))
  }
  /** Nothing else ages a session out, so the table only ever grew: measured on a real machine,
   *  5,052 rows in 9 days at ~700 joins a day, with 8 alive. A session still named by a handoff
   *  or a claim is kept whatever its age -- foreign keys are on, and that row is also the only
   *  thing that can put a name to the work pointing at it. */
  private prune(): void {
    this.retireAbandoned()
    this.db
      .prepare(
        `DELETE FROM sessions WHERE lastSeen < ?
         AND id NOT IN (SELECT sender FROM messages UNION SELECT recipient FROM messages
                        UNION SELECT owner FROM work)`
      )
      .run(this.now() - COORDINATION.sessionTtlMs)
  }
  retireAbandoned(): { notes: number; claims: number } {
    const now = this.now()
    const cutoff = now - COORDINATION.abandonMs
    const record = this.db.prepare(
      'INSERT INTO events(project, actor, kind, target, at, detail) VALUES(?,?,?,?,?,?)'
    )
    return this.db.transaction(() => {
      const notes = this.db
        .prepare(
          `SELECT m.id, m.project, m.recipient FROM messages m JOIN sessions r ON r.id = m.recipient
           WHERE m.state = 'pending' AND r.lastSeen < ?`
        )
        .all(cutoff) as { id: string; project: string; recipient: string }[]
      for (const note of notes) {
        this.db
          .prepare("UPDATE messages SET state='declined', note=?, updatedAt=? WHERE id=?")
          .run(ABANDONED_NOTE, now, note.id)
        record.run(note.project, note.recipient, 'expired', note.id, now, JSON.stringify({ note: ABANDONED_NOTE }))
      }
      const claims = this.db
        .prepare(
          "SELECT project, id, owner FROM work WHERE state IN ('working','blocked') AND expiresAt < ?"
        )
        .all(cutoff) as { project: string; id: string; owner: string }[]
      for (const claim of claims) {
        this.db
          .prepare("UPDATE work SET state='released', note=?, updatedAt=? WHERE project=? AND id=?")
          .run(ABANDONED_CLAIM, now, claim.project, claim.id)
        record.run(claim.project, claim.owner, 'released', claim.id, now, JSON.stringify({ note: ABANDONED_CLAIM }))
      }
      return { notes: notes.length, claims: claims.length }
    })()
  }
  register(input: Registration, token: string): CoordinationSession {
    const args = registrationSchema.parse(input)
    this.prune()
    const id = tokenHash(JSON.stringify([args.project, args.harness, args.session]))
    const row: SessionRow = {
      ...args,
      id,
      tokenHash: tokenHash(token),
      lastSeen: this.now(),
      state: 'active'
    }
    // Joining a directory is what creates its project; naming it later is a separate, optional act.
    this.db
      .prepare(
        `INSERT INTO projects(id, name, tags, "order", state, createdAt, updatedAt)
      VALUES(?,?,'[]',0,'active',?,?) ON CONFLICT(id) DO NOTHING`
      )
      .run(args.project, args.projectName, this.now(), this.now())
    this.db
      .prepare(
        `INSERT INTO sessions(id, project, projectName, session, harness, label, cwd, version, tokenHash, lastSeen, state)
      VALUES(@id,@project,@projectName,@session,@harness,@label,@cwd,@version,@tokenHash,@lastSeen,@state)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label,cwd=excluded.cwd,version=excluded.version,
        tokenHash=excluded.tokenHash,lastSeen=excluded.lastSeen,state=excluded.state`
      )
      .run(row)
    return this.publicSession(row)
  }
  knows(token: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM sessions WHERE tokenHash=?').get(tokenHash(token))
  }
  private actor(token: string): SessionRow {
    const actor = this.db
      .prepare('SELECT * FROM sessions WHERE tokenHash=?')
      .get(tokenHash(token)) as SessionRow | undefined
    if (!actor)
      throw new CoordinationError('unauthorized', 'Join this project before checking its work.')
    return actor
  }
  private publicSession(row: SessionRow): CoordinationSession {
    const { tokenHash: _secret, ...rest } = row
    void _secret
    return { ...rest, stale: this.now() - row.lastSeen > COORDINATION.staleMs }
  }
  private publicMessage(row: MessageRow): CoordinationMessage {
    const { requestKey: _key, fingerprint: _fingerprint, ...rest } = row
    void _key
    void _fingerprint
    return { ...rest, refs: JSON.parse(row.refs) }
  }
  private publicProject(row: ProjectRow): CoordinationProject {
    return { ...row, tags: JSON.parse(row.tags) }
  }
  private project(id: string): ProjectRow {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as ProjectRow | undefined
    if (!row) throw new CoordinationError('not_found', 'That project has not been joined yet.')
    return row
  }
  private publicWork(row: WorkRow): CoordinationWork {
    return {
      ...row,
      refs: JSON.parse(row.refs),
      expired: row.expiresAt <= this.now() && !['complete', 'released'].includes(row.state)
    }
  }
  call(op: CoordinationOp, input: unknown, token: string): unknown {
    const actor = this.actor(token)
    const args = coordinationSchemas[op].parse(input)
    // Serialize read-then-write operations across connections, including claim races.
    return this.db
      .transaction(() => {
        switch (op) {
          case 'status':
            return this.snapshot(actor.project, (args as CoordinationArgs<'status'>).cursor)
          case 'inbox':
            return this.inbox(actor, args as CoordinationArgs<'inbox'>)
          case 'send':
            return this.send(actor, args as CoordinationArgs<'send'>)
          case 'ack':
            return this.ack(actor, args as CoordinationArgs<'ack'>)
          case 'claim':
            return this.claim(actor, args as CoordinationArgs<'claim'>)
          case 'update':
            return this.update(actor, args as CoordinationArgs<'update'>)
          case 'project_add':
            return this.projectAdd(actor, args as CoordinationArgs<'project_add'>)
          case 'project_update':
            return this.projectUpdate(actor, args as CoordinationArgs<'project_update'>)
          case 'project_archive':
            return this.projectArchive(actor, args as CoordinationArgs<'project_archive'>)
          case 'project_delete':
            return this.projectDelete(actor, args as CoordinationArgs<'project_delete'>)
          case 'heartbeat': {
            this.db
              .prepare('UPDATE sessions SET lastSeen=?,state=? WHERE id=?')
              .run(this.now(), (args as CoordinationArgs<'heartbeat'>).state, actor.id)
            this.db
              .prepare(
                "UPDATE work SET expiresAt=? WHERE owner=? AND expiresAt>? AND state IN ('working','blocked')"
              )
              .run(this.now() + COORDINATION.leaseMs, actor.id, this.now())
            return { ok: true }
          }
        }
      })
      .immediate()
  }
  snapshot(project?: string, cursor = 0): CoordinationSnapshot {
    const filter = project ? ' WHERE project=?' : ''
    const params = project ? [project] : []
    const projects = (
      this.db
        .prepare(
          `SELECT * FROM projects${project ? ' WHERE id=?' : ''} ORDER BY "order", name LIMIT 500`
        )
        .all(...params) as ProjectRow[]
    ).map((r) => this.publicProject(r))
    const sessions = (
      this.db
        .prepare(`SELECT * FROM sessions${filter} ORDER BY lastSeen DESC LIMIT 500`)
        .all(...params) as SessionRow[]
    ).map((r) => this.publicSession(r))
    const work = (
      this.db
        .prepare(`SELECT * FROM work${filter} ORDER BY updatedAt DESC LIMIT 200`)
        .all(...params) as WorkRow[]
    ).map((r) => this.publicWork(r))
    const messages = (
      this.db
        .prepare(`SELECT * FROM messages${filter} ORDER BY createdAt DESC LIMIT 100`)
        .all(...params) as MessageRow[]
    ).map((r) => this.publicMessage(r))
    const events = this.db
      .prepare(
        `SELECT * FROM events WHERE seq>?${project ? ' AND project=?' : ''} ORDER BY seq LIMIT ?`
      )
      .all(cursor, ...params, COORDINATION.maxPage + 1) as Array<
      Omit<CoordinationEvent, 'detail'> & { detail: string }
    >
    const hasMore = events.length > COORDINATION.maxPage
    if (hasMore) events.pop()
    return {
      enabled: true,
      version: COORDINATION.version,
      projects,
      sessions,
      work,
      messages,
      events: events.map((e) => ({ ...e, detail: JSON.parse(e.detail) })),
      cursor: events.at(-1)?.seq ?? cursor,
      hasMore,
      generatedAt: this.now()
    }
  }
  private ownProject(actor: SessionRow, id: string): ProjectRow {
    if (id !== actor.project)
      throw new CoordinationError('unauthorized', 'Join a project before changing it.')
    return this.project(id)
  }
  private projectAdd(
    actor: SessionRow,
    args: CoordinationArgs<'project_add'>
  ): CoordinationProject {
    const existing = this.ownProject(actor, args.project)
    const row: ProjectRow = {
      ...existing,
      name: args.name,
      tags: JSON.stringify(args.tags),
      order: args.order,
      updatedAt: this.now()
    }
    this.db
      .prepare('UPDATE projects SET name=?,tags=?,"order"=?,updatedAt=? WHERE id=?')
      .run(row.name, row.tags, row.order, row.updatedAt, row.id)
    this.event(actor, 'project_named', row.id, { name: row.name })
    return this.publicProject(row)
  }
  private projectUpdate(
    actor: SessionRow,
    args: CoordinationArgs<'project_update'>
  ): CoordinationProject {
    const existing = this.ownProject(actor, args.project)
    const row: ProjectRow = {
      ...existing,
      name: args.name ?? existing.name,
      tags: args.tags ? JSON.stringify(args.tags) : existing.tags,
      order: args.order ?? existing.order,
      updatedAt: this.now()
    }
    this.db
      .prepare('UPDATE projects SET name=?,tags=?,"order"=?,updatedAt=? WHERE id=?')
      .run(row.name, row.tags, row.order, row.updatedAt, row.id)
    this.event(actor, 'project_updated', row.id, { name: row.name })
    return this.publicProject(row)
  }
  private projectArchive(
    actor: SessionRow,
    args: CoordinationArgs<'project_archive'>
  ): CoordinationProject {
    const existing = this.ownProject(actor, args.project)
    const row: ProjectRow = {
      ...existing,
      state: args.archived ? 'archived' : 'active',
      updatedAt: this.now()
    }
    this.db
      .prepare('UPDATE projects SET state=?,updatedAt=? WHERE id=?')
      .run(row.state, row.updatedAt, row.id)
    this.event(actor, args.archived ? 'project_archived' : 'project_restored', row.id)
    return this.publicProject(row)
  }
  /** Rename or archive from MightyMouse itself. `ownProject` exists so one agent cannot rename
   *  another agent's project; the person at the machine is not another agent, and has no session
   *  row to act through. `events.actor` carries no foreign key, so 'operator' records honestly. */
  operatorProject(
    id: string,
    change: { name?: string; archived?: boolean }
  ): CoordinationProject {
    return this.db
      .transaction(() => {
        const existing = this.project(id)
        const row: ProjectRow = {
          ...existing,
          name: change.name?.trim() || existing.name,
          state: change.archived === undefined ? existing.state : change.archived ? 'archived' : 'active',
          updatedAt: this.now()
        }
        this.db
          .prepare('UPDATE projects SET name=?,state=?,updatedAt=? WHERE id=?')
          .run(row.name, row.state, row.updatedAt, row.id)
        this.db
          .prepare('INSERT INTO events(project, actor, kind, target, at, detail) VALUES(?,?,?,?,?,?)')
          .run(
            row.id,
            'operator',
            change.archived === undefined
              ? 'project_updated'
              : change.archived
                ? 'project_archived'
                : 'project_restored',
            row.id,
            this.now(),
            JSON.stringify({ name: row.name })
          )
        return this.publicProject(row)
      })
      .immediate()
  }
  private projectDelete(actor: SessionRow, args: CoordinationArgs<'project_delete'>): {
    deleted: string
  } {
    const row = this.ownProject(actor, args.project)
    // Sessions are removed last: messages reference them, and foreign keys are enforced here.
    this.db.prepare('DELETE FROM events WHERE project=?').run(row.id)
    this.db.prepare('DELETE FROM work WHERE project=?').run(row.id)
    this.db.prepare('DELETE FROM messages WHERE project=?').run(row.id)
    this.db.prepare('DELETE FROM sessions WHERE project=?').run(row.id)
    this.db.prepare('DELETE FROM projects WHERE id=?').run(row.id)
    return { deleted: row.id }
  }
  private inbox(actor: SessionRow, args: CoordinationArgs<'inbox'>): CoordinationMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE recipient=? AND state IN ('pending','accepted') ORDER BY createdAt,id LIMIT ?"
      )
      .all(actor.id, args.limit) as MessageRow[]
    for (const row of rows) {
      if (row.offeredAt !== null) continue
      this.db.prepare('UPDATE messages SET offeredAt=? WHERE id=?').run(this.now(), row.id)
      row.offeredAt = this.now()
      this.event(actor, 'offered', row.id)
    }
    return rows.map((r) => this.publicMessage(r))
  }
  private send(actor: SessionRow, args: CoordinationArgs<'send'>): CoordinationMessage {
    const fingerprint = tokenHash(JSON.stringify(args))
    const previous = this.db
      .prepare('SELECT * FROM messages WHERE sender=? AND requestKey=?')
      .get(actor.id, args.key) as MessageRow | undefined
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new CoordinationError(
          'conflict',
          'That retry key already belongs to a different message.'
        )
      return this.publicMessage(previous)
    }
    const recipient = this.db
      .prepare(
        `SELECT * FROM sessions WHERE id=? OR session=? OR label=?
         ORDER BY id=? DESC, project=? DESC, lastSeen DESC LIMIT 1`
      )
      .get(args.to, args.to, args.to, args.to, actor.project) as SessionRow | undefined
    if (!recipient)
      throw new CoordinationError('not_found', 'Choose a recipient who has joined shared work.')
    const pending = this.db
      .prepare(
        "SELECT count(*) AS n FROM messages WHERE recipient=? AND state IN ('pending','accepted')"
      )
      .get(recipient.id) as { n: number }
    if (pending.n >= COORDINATION.maxSessionPending)
      throw new CoordinationError(
        'backpressure',
        'This recipient has too many pending handoffs. Resolve existing work first.'
      )
    const row: MessageRow = {
      id: randomUUID(),
      project: actor.project,
      sender: actor.id,
      recipient: recipient.id,
      requestKey: args.key,
      fingerprint,
      subject: args.subject,
      body: args.body,
      refs: JSON.stringify(args.refs),
      work: args.work ?? null,
      state: 'pending',
      note: '',
      createdAt: this.now(),
      offeredAt: null,
      updatedAt: this.now()
    }
    this.db
      .prepare(
        `INSERT INTO messages VALUES(@id,@project,@sender,@recipient,@requestKey,@fingerprint,
      @subject,@body,@refs,@work,@state,@note,@createdAt,@offeredAt,@updatedAt)`
      )
      .run(row)
    this.event(actor, 'sent', row.id)
    return this.publicMessage(row)
  }
  private ack(actor: SessionRow, args: CoordinationArgs<'ack'>): CoordinationMessage {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE id=? AND recipient=?')
      .get(args.message, actor.id) as MessageRow | undefined
    if (!row)
      throw new CoordinationError('not_found', 'That message is not addressed to this session.')
    if (row.state === args.state && row.note === args.note) return this.publicMessage(row)
    if (row.state === 'completed' || row.state === 'declined')
      throw new CoordinationError('conflict', 'This handoff already has a final receipt.')
    row.state = args.state
    row.note = args.note
    row.updatedAt = this.now()
    this.db
      .prepare('UPDATE messages SET state=?,note=?,updatedAt=? WHERE id=?')
      .run(row.state, row.note, row.updatedAt, row.id)
    this.event(actor, args.state, row.id, args)
    return this.publicMessage(row)
  }
  handoffTarget(
    messageId: string
  ): { recipient: CoordinationSession; senderLabel: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT r.*, s.label AS senderLabel FROM messages m
         JOIN sessions r ON r.id = m.recipient JOIN sessions s ON s.id = m.sender
         WHERE m.id = ? AND m.state = 'pending' AND m.offeredAt IS NULL`
      )
      .get(messageId) as (SessionRow & { senderLabel: string }) | undefined
    if (!row) return undefined
    const { senderLabel, ...recipient } = row
    return { recipient: this.publicSession(recipient), senderLabel }
  }
  unreadFor(harnessSession: string): CoordinationMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN sessions r ON r.id = m.recipient
         WHERE r.session = ? AND m.state = 'pending' AND m.offeredAt IS NULL ORDER BY m.createdAt`
      )
      .all(harnessSession) as MessageRow[]
    return rows.map((r) => this.publicMessage(r))
  }
  bounce(messageId: string, note: string): CoordinationMessage | undefined {
    const row = this.db
      .prepare(
        `SELECT r.* FROM messages m JOIN sessions r ON r.id = m.recipient
         WHERE m.id = ? AND m.state = 'pending'`
      )
      .get(messageId) as SessionRow | undefined
    if (!row) return undefined
    this.db
      .prepare("UPDATE messages SET state='declined', note=?, updatedAt=? WHERE id=?")
      .run(note, this.now(), messageId)
    this.event(row, 'bounced', messageId, { note })
    const message = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as MessageRow
    return this.publicMessage(message)
  }
  private claim(actor: SessionRow, args: CoordinationArgs<'claim'>): CoordinationWork {
    const old = this.db
      .prepare('SELECT * FROM work WHERE project=? AND id=?')
      .get(actor.project, args.work) as WorkRow | undefined
    if (old?.state === 'complete')
      throw new CoordinationError(
        'conflict',
        'This work is complete. Create a new work item for a new change.'
      )
    const live = old && old.expiresAt > this.now() && old.state !== 'released'
    if (live && old.owner !== actor.id)
      throw new CoordinationError(
        'conflict',
        'Another session owns this work. Wait for its handoff or expiry.'
      )
    if (live && (old.title !== args.title || old.acceptance !== args.acceptance))
      throw new CoordinationError(
        'conflict',
        'The work title or acceptance check changed. Release it before redefining it.'
      )
    const row: WorkRow = {
      project: actor.project,
      id: args.work,
      title: args.title,
      acceptance: args.acceptance,
      owner: actor.id,
      generation: live ? old.generation : (old?.generation ?? 0) + 1,
      expiresAt: this.now() + COORDINATION.leaseMs,
      state: 'working',
      stage:
        old && old.title === args.title && old.acceptance === args.acceptance
          ? old.stage
          : 'scoped',
      note: old?.note ?? '',
      refs: old?.refs ?? '[]',
      emoji: args.emoji ?? old?.emoji ?? '',
      updatedAt: this.now()
    }
    this.db
      .prepare(
        `INSERT INTO work(project,id,title,acceptance,owner,generation,expiresAt,state,stage,note,refs,emoji,updatedAt)
        VALUES(@project,@id,@title,@acceptance,@owner,@generation,@expiresAt,@state,@stage,@note,@refs,@emoji,@updatedAt)
      ON CONFLICT(project,id) DO UPDATE SET title=excluded.title,acceptance=excluded.acceptance,
        owner=excluded.owner,generation=excluded.generation,expiresAt=excluded.expiresAt,state=excluded.state,stage=excluded.stage,emoji=excluded.emoji,updatedAt=excluded.updatedAt`
      )
      .run(row)
    this.event(actor, live ? 'renewed' : 'claimed', row.id, { ...args, generation: row.generation })
    return this.publicWork(row)
  }
  private update(actor: SessionRow, args: CoordinationArgs<'update'>): CoordinationWork {
    const row = this.db
      .prepare('SELECT * FROM work WHERE project=? AND id=?')
      .get(actor.project, args.work) as WorkRow | undefined
    if (
      !row ||
      row.owner !== actor.id ||
      row.generation !== args.generation ||
      row.expiresAt <= this.now() ||
      row.state === 'released' ||
      row.state === 'complete'
    ) {
      throw new CoordinationError(
        'conflict',
        'Ownership expired or changed. Claim the work again before updating it.'
      )
    }
    if (
      (args.state === 'complete' ||
        ['verified', 'shipped', 'observed'].includes(args.stage ?? '')) &&
      !args.refs.length
    ) {
      throw new CoordinationError(
        'invalid',
        'Include evidence before marking this work checked, shipped or complete.'
      )
    }
    row.state = args.state
    row.stage = args.stage ?? row.stage
    row.emoji = args.emoji ?? row.emoji
    row.note = args.note
    row.refs = JSON.stringify(args.refs)
    row.updatedAt = this.now()
    row.expiresAt = ['released', 'complete'].includes(args.state)
      ? this.now()
      : this.now() + COORDINATION.leaseMs
    this.db
      .prepare(
        'UPDATE work SET state=@state,stage=@stage,emoji=@emoji,note=@note,refs=@refs,updatedAt=@updatedAt,expiresAt=@expiresAt WHERE project=@project AND id=@id'
      )
      .run(row)
    this.event(actor, args.state, row.id, args)
    return this.publicWork(row)
  }
}
