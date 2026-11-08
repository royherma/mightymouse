import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { MediaAttachment } from '../../../shared/types'
import { toAttachment } from '../../../shared/attachments'

/**
 * Shared attachment state for any composer (panel + MightyChat). Owns the list,
 * the native-picker round-trip, and the drag-drop → MediaAttachment conversion in
 * ONE place so the two surfaces can't drift. Kind inference comes from the shared
 * classifier (`toAttachment`), the same code the main-process picker uses, so a
 * dropped file and a picked file classify identically.
 *
 * Returns the list plus three handlers: `pick` (open native dialog), `drop`
 * (handle a DataTransfer drop), and `remove`/`clear` for chip management.
 */
export interface UseAttachments {
  attachments: MediaAttachment[]
  pick: () => Promise<void>
  drop: (e: React.DragEvent) => void
  addFiles: (files: File[]) => number
  addPaths: (paths: string[]) => void
  paste: (data: DataTransfer) => boolean
  remove: (path: string) => void
  clear: () => void
}

const keptByKey = new Map<string, MediaAttachment[]>()

export function droppedImage(data: DataTransfer): { file: File; url?: undefined } | { file?: undefined; url: string } | null {
  const file = Array.from(data.files).find((f) => f.type.startsWith('image/'))
  if (file) return { file }
  const url = new DOMParser().parseFromString(data.getData('text/html'), 'text/html').querySelector('img')?.getAttribute('src')
  return url && /^https?:/.test(url) ? { url } : null
}

export function useAttachments(rememberKey?: string): UseAttachments {
  const [attachments, setShown] = useState<MediaAttachment[]>(() => (rememberKey && keptByKey.get(rememberKey)) || [])
  const [shownKey, setShownKey] = useState(rememberKey)
  if (shownKey !== rememberKey) {
    setShownKey(rememberKey)
    setShown((rememberKey && keptByKey.get(rememberKey)) || [])
  }
  const setAttachments = useCallback(
    (next: (prev: MediaAttachment[]) => MediaAttachment[]) =>
      setShown((prev) => {
        const value = next(prev)
        if (rememberKey && value.length > 0) keptByKey.set(rememberKey, value)
        else if (rememberKey) keptByKey.delete(rememberKey)
        return value
      }),
    [rememberKey]
  )

  // Append, de-duping by path so the same file dropped/picked twice shows once.
  const add = useCallback((next: MediaAttachment[]) => {
    if (next.length === 0) return
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.path))
      return [...prev, ...next.filter((a) => !seen.has(a.path))]
    })
  }, [setAttachments])

  const pick = useCallback(async () => {
    const picked = await window.api.pickAttachments()
    add(picked)
  }, [add])

  // Resolve each dropped File → absolute path via the preload bridge (Electron 32+
  // removed File.path; webUtils.getPathForFile is preload-only), then classify it
  // the shared way so a dropped file matches a picked one.
  const addFiles = useCallback(
    (files: File[]) => {
      const next = files
        .map((f) => window.api.pathForFile(f))
        .filter((p): p is string => typeof p === 'string' && p !== '')
        .map(toAttachment)
      add(next)
      return next.length
    },
    [add]
  )

  const drop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      if (addFiles(Array.from(e.dataTransfer.files)) > 0) return
      const image = droppedImage(e.dataTransfer)
      if (!image) return
      const source = image.file
        ? image.file.arrayBuffer().then((buffer) => ({ name: image.file.name, bytes: new Uint8Array(buffer), type: image.file.type }))
        : Promise.resolve({ name: decodeURIComponent(new URL(image.url).pathname.split('/').pop() ?? ''), url: image.url })
      void source.then(window.api.saveDroppedImage).then((a) => a && add([a]))
    },
    [add, addFiles]
  )

  const paste = useCallback(
    (data: DataTransfer) => {
      if (addFiles(Array.from(data.files)) > 0) return true
      const hasImage = Array.from(data.items).some(
        (i) => i.kind === 'file' && i.type.startsWith('image/')
      )
      if (!hasImage) return false
      void window.api.pasteClipboardImage().then((a) => a && add([a]))
      return true
    },
    [add, addFiles]
  )

  const addPaths = useCallback((paths: string[]) => add(paths.map(toAttachment)), [add])

  const remove = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path))
  }, [setAttachments])

  const clear = useCallback(() => setAttachments(() => []), [setAttachments])

  return { attachments, pick, drop, addFiles, addPaths, paste, remove, clear }
}

function inBackgroundGridPane(input: HTMLElement): boolean {
  return input.closest('[data-grid-pane]')?.getAttribute('data-focused') === 'false'
}

export function usePasteToComposer(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  paste: (data: DataTransfer) => boolean,
  appendText: (text: string) => void,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return
    const onPaste = (e: ClipboardEvent): void => {
      const input = inputRef.current
      const target = e.target as HTMLElement | null
      const elsewhere =
        target !== input &&
        (target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA')
      if (!input || !e.clipboardData || elsewhere) return
      if (target !== input && inBackgroundGridPane(input)) return
      if (paste(e.clipboardData)) {
        e.preventDefault()
        input.focus()
        return
      }
      if (target === input) return
      const text = e.clipboardData.getData('text/plain')
      if (!text) return
      e.preventDefault()
      appendText(text)
      input.focus()
      requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length))
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [inputRef, paste, appendText, enabled])
}

const COMPOSER_INBOX_EVENT = 'mm:composer-attach'

export function sendToComposer(path: string): boolean {
  return !window.dispatchEvent(new CustomEvent(COMPOSER_INBOX_EVENT, { detail: path, cancelable: true }))
}

const COMPOSER_TEXT_EVENT = 'mm:composer-text'

export function sendTextToComposer(text: string, append = false): boolean {
  return !window.dispatchEvent(new CustomEvent(COMPOSER_TEXT_EVENT, { detail: { text, append }, cancelable: true }))
}

export function useComposerInbox(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  addPaths: (paths: string[]) => void,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return
    const onAttach = (e: Event): void => {
      const input = inputRef.current
      if (e.defaultPrevented || !input?.offsetParent || inBackgroundGridPane(input)) return
      e.preventDefault()
      addPaths([(e as CustomEvent<string>).detail])
      input.focus()
    }
    const onText = (e: Event): void => {
      const input = inputRef.current
      if (e.defaultPrevented || !input?.offsetParent || inBackgroundGridPane(input)) return
      e.preventDefault()
      const { text, append } = (e as CustomEvent<{ text: string; append: boolean }>).detail
      const value = append && input.value.trim() ? `${input.value.trimEnd()}\n\n${text}` : text
      // The native setter plus an input event is what makes React's onChange see a value set from outside.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
    }
    window.addEventListener(COMPOSER_INBOX_EVENT, onAttach)
    window.addEventListener(COMPOSER_TEXT_EVENT, onText)
    return () => {
      window.removeEventListener(COMPOSER_INBOX_EVENT, onAttach)
      window.removeEventListener(COMPOSER_TEXT_EVENT, onText)
    }
  }, [inputRef, addPaths, enabled])
}
