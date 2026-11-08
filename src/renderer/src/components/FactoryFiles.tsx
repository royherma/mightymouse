import { useEffect, useRef, useState } from 'react'
import { Code2, FileText, FolderOpen, Image, Paperclip } from 'lucide-react'
import {
  FACTORY_MATERIALS,
  type FactoryFile,
  type FactoryMaterials,
  type FactoryTask
} from '../../../shared/factory'
import { Button } from './Button'

export function FactoryFiles({ task }: { task: FactoryTask }): React.JSX.Element {
  const [materials, setMaterials] = useState<FactoryMaterials>({ files: [], notes: [] })
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<FactoryFile | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const imageDialog = useRef<HTMLDialogElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    let active = true
    const load = async (): Promise<void> => {
      try {
        const next = await window.api.factoryMaterials({ action: 'list', taskId: task.id })
        if (!active || current !== generation.current) return
        setMaterials(next)
        setLoading(false)
        for (const file of next.files.filter((item) => item.mime.startsWith('image/'))) {
          const result = await window.api.factoryMaterials({
            action: 'preview',
            taskId: task.id,
            fileId: file.id
          })
          if (!active || current !== generation.current) return
          if (result.preview) setPreviews((values) => ({ ...values, [file.id]: result.preview! }))
        }
      } catch (err) {
        if (active) {
          setLoading(false)
          setError(err instanceof Error ? err.message : 'Files could not be loaded.')
        }
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [task.id, task.stage])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save.')
    } finally {
      setBusy(false)
    }
  }
  const addFiles = (files: File[]): void => {
    if (busy) return
    void run(async () => {
      for (const file of files) {
        if (file.size > FACTORY_MATERIALS.maxBytes)
          throw new Error(`${file.name} is larger than 10 MB.`)
        const next = await window.api.factoryMaterials({
          action: 'add',
          taskId: task.id,
          name: file.name,
          data: new Uint8Array(await file.arrayBuffer()),
          origin: task.stage === 'draft' ? 'reference' : 'output'
        })
        setMaterials(next)
        const saved = next.files.at(-1)
        if (saved?.mime.startsWith('image/')) {
          const result = await window.api.factoryMaterials({
            action: 'preview',
            taskId: task.id,
            fileId: saved.id
          })
          if (result.preview) setPreviews((values) => ({ ...values, [saved.id]: result.preview! }))
        }
      }
    })
  }
  const show = (file: FactoryFile): void => {
    void run(async () => {
      if (file.mime === 'application/pdf') {
        await window.api.factoryMaterials({ action: 'open', taskId: task.id, folder: 'task' })
        return
      }
      const result = await window.api.factoryMaterials({
        action: 'preview',
        taskId: task.id,
        fileId: file.id
      })
      setPreviews((values) => ({ ...values, [file.id]: result.preview ?? '' }))
      setPreview(file)
    })
  }
  const openFolder = (folder: 'task' | 'code'): void =>
    void run(async () => {
      await window.api.factoryMaterials({ action: 'open', taskId: task.id, folder })
    })
  return (
    <div>
      <section
        className="factory-detail-section factory-files-section"
        tabIndex={0}
        aria-label="Files. Paste or drop files here"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          addFiles(Array.from(event.dataTransfer.files))
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files)
          if (files.length) {
            event.preventDefault()
            addFiles(files)
          }
        }}
      >
        <div className="factory-section-head">
          <h3>Files</h3>
          <Button
            variant="bare"
            className="factory-small-button"
            disabled={busy}
            onClick={() => picker.current?.click()}
          >
            <Paperclip size={13} />
            {busy ? 'Saving…' : 'Attach'}
          </Button>
          <Button
            variant="bare"
            className="factory-small-button"
            disabled={busy}
            onClick={() => openFolder('task')}
          >
            <FolderOpen size={13} /> Folder
          </Button>
          {task.worktree && (
            <Button
              variant="bare"
              className="factory-small-button"
              disabled={busy}
              onClick={() => openFolder('code')}
            >
              <Code2 size={13} /> Code
            </Button>
          )}
        </div>
        {loading ? (
          <p className="text-xs text-muted">Loading files…</p>
        ) : (
          materials.files.length === 0 && (
            <p className="text-xs text-muted">
              {task.stage === 'draft'
                ? 'Drop or paste images here, up to 10 MB each.'
                : 'Drop results here. The running task keeps the references it started with.'}
            </p>
          )
        )}
        {(['reference', 'output'] as const).map((origin) => {
          const files = materials.files.filter((file) => file.origin === origin)
          return (
            files.length > 0 && (
              <div key={origin} className="mt-3">
                <p className="mb-2 text-xs text-muted">
                  {origin === 'reference' ? 'References' : 'Results'}
                </p>
                <div className="factory-files">
                  {files.map((file) => (
                    <Button
                      key={file.id}
                      variant="bare"
                      className="factory-file"
                      disabled={busy}
                      onClick={() => show(file)}
                    >
                      {previews[file.id] && file.mime.startsWith('image/') ? (
                        <img src={previews[file.id]} alt="" />
                      ) : file.mime.startsWith('image/') ? (
                        <Image size={18} />
                      ) : (
                        <FileText size={18} />
                      )}
                      <span>
                        {file.name}
                        <span className="block text-xs text-muted">
                          {Math.max(1, Math.round(file.bytes / 1024))} KB
                        </span>
                      </span>
                    </Button>
                  ))}
                </div>
              </div>
            )
          )
        })}
        {preview && (
          <div className="mt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm">{preview.name}</span>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Close preview
              </Button>
            </div>
            {preview.mime.startsWith('image/') ? (
              <>
                <img
                  className="factory-file-preview"
                  src={previews[preview.id]}
                  alt={preview.name}
                />
                <Button
                  variant="ghost"
                  className="mt-2"
                  onClick={() => imageDialog.current?.showModal()}
                >
                  View full size
                </Button>
                <dialog
                  ref={imageDialog}
                  className="factory-image-dialog"
                  aria-label={preview.name}
                >
                  <Button variant="ghost" onClick={() => imageDialog.current?.close()}>
                    Close image
                  </Button>
                  <img src={previews[preview.id]} alt={preview.name} />
                </dialog>
              </>
            ) : (
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                {previews[preview.id]}
              </pre>
            )}
          </div>
        )}
        <input
          ref={picker}
          className="hidden"
          type="file"
          multiple
          accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,.json"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
        {error && (
          <p className="mt-2 text-sm text-accent" role="alert">
            {error}
          </p>
        )}
      </section>
      <section className="factory-detail-section">
        <h3>Notes</h3>
        {materials.notes.map((item) => (
          <div className="factory-note text-sm" key={item.id}>
            {item.text}
            <time className="mt-1 block text-xs text-muted">
              {new Date(item.createdAt).toLocaleString()}
            </time>
          </div>
        ))}
        <textarea
          className="factory-note-input"
          rows={2}
          aria-label="Task note"
          placeholder="Add a note for you and the next build attempt"
          maxLength={FACTORY_MATERIALS.maxNoteLength}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          variant="ghost"
          className={note.trim() ? 'mt-2' : 'hidden'}
          disabled={busy || !note.trim()}
          onClick={() =>
            void run(async () => {
              setMaterials(
                await window.api.factoryMaterials({ action: 'note', taskId: task.id, text: note })
              )
              setNote('')
            })
          }
        >
          Save note
        </Button>
      </section>
    </div>
  )
}
