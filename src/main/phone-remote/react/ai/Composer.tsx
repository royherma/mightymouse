import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ArrowUp, Camera, Loader2, Mic, Paperclip, Square, X } from 'lucide-react'
import { CONFIG } from '@shared/config'
import { hapticTick } from '../haptics'
import { MicWaveform } from '../MicWaveform'
import { Button } from '@shared/ui/Button'

export interface ComposerMic {
  onMicDown: () => void
  onMicUp: () => void
  dictating: boolean
  recording: boolean
  micStreamRef: RefObject<MediaStream | null>
  draftPatch: string | null
  onDraftConsumed: () => void
}

export interface ComposerFill {
  text: string
  n: number
}

export function Composer(props: {
  placeholder: string
  busy?: boolean
  disabled?: boolean
  onSend: (text: string, file: File | null) => boolean | void
  onStop?: () => void
  mic?: ComposerMic
  allowPhoto?: boolean
  fill?: ComposerFill | null
  error?: string
  bare?: boolean
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState('')
  const [micEl, setMicEl] = useState<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const pickRef = useRef<HTMLInputElement | null>(null)
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  useEffect(() => {
    if (!props.fill) return
    setText(props.fill.text)
    inputRef.current?.focus()
  }, [props.fill])

  const patch = props.mic?.draftPatch
  const consume = props.mic?.onDraftConsumed
  useEffect(() => {
    if (patch == null || !consume) return
    setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${patch}` : patch))
    consume()
  }, [patch, consume])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const canSend = !props.disabled && (text.trim() !== '' || file !== null)

  const submit = (): void => {
    if (!canSend) return
    hapticTick()
    if (props.onSend(text.trim(), file) === false) return
    setText('')
    setFile(null)
  }

  const pick = (picked: File | undefined): void => {
    if (!picked) return
    if (picked.size > CONFIG.PHONE_REMOTE.MAX_IMAGE_BYTES) {
      setFileError('That photo is too big to send')
      return
    }
    setFileError('')
    setFile(picked)
  }

  const onMicDown = props.mic?.onMicDown
  const onMicUp = props.mic?.onMicUp
  // Non-passive native listeners: React's pointer handlers are passive, and iOS's
  // follow-up mouse events then flip a tap-started recording straight back off.
  useEffect(() => {
    if (!micEl || !onMicDown || !onMicUp) return
    const down = (e: PointerEvent): void => {
      e.preventDefault()
      hapticTick()
      onMicDown()
    }
    const up = (e: PointerEvent): void => {
      e.preventDefault()
      onMicUp()
    }
    micEl.addEventListener('pointerdown', down, { passive: false })
    micEl.addEventListener('pointerup', up)
    micEl.addEventListener('pointercancel', up)
    return () => {
      micEl.removeEventListener('pointerdown', down)
      micEl.removeEventListener('pointerup', up)
      micEl.removeEventListener('pointercancel', up)
    }
  }, [micEl, onMicDown, onMicUp])

  const recording = props.mic?.recording ?? false
  const dictating = props.mic?.dictating ?? false
  const micShown = Boolean(props.mic) && (recording || dictating || (!text.trim() && !file && !props.busy))

  return (
    <div className={props.bare ? 'aiComposerBare' : 'aiComposer'}>
      {(props.error || fileError) && <div className="aiToast">{props.error || fileError}</div>}
      {preview && file && (
        <div className="aiAttach">
          <div>
            <img src={preview} alt={file.name} />
            <Button variant="bare" type="button" aria-label={`Remove ${file.name}`} onClick={() => setFile(null)}>
              <X size={12} strokeWidth={3} />
            </Button>
          </div>
          <span>1 photo goes with your next message</span>
        </div>
      )}
      <div className="aiComposerRow">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={recording ? 'Listening…' : dictating ? 'Writing it down…' : props.placeholder}
          onChange={(e) => setText(e.target.value)}
          maxLength={CONFIG.PHONE_REMOTE.CHAT_MESSAGE_MAX_CHARS}
          enterKeyHint="send"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {props.allowPhoto && (
          <>
            <Button variant="bare" type="button" className="aiSmBtn" aria-label="Add a photo" onClick={() => pickRef.current?.click()}>
              {props.bare ? <Paperclip size={16} strokeWidth={2.2} /> : <Camera size={16} strokeWidth={2.2} />}
              {props.bare && 'Photo'}
            </Button>
            <input
              ref={pickRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                pick(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </>
        )}
        {micShown && props.mic && (
          <Button
            variant="bare"
            ref={setMicEl}
            type="button"
            className={`aiMic${recording ? ' aiMicOn' : ''}`}
            aria-label={recording ? 'Stop recording' : 'Talk'}
            onContextMenu={(e) => e.preventDefault()}
          >
            {dictating ? (
              <Loader2 size={18} strokeWidth={2.4} className="chatMicSpin" />
            ) : recording ? (
              <MicWaveform streamRef={props.mic.micStreamRef} />
            ) : (
              <Mic size={18} strokeWidth={2.2} />
            )}
          </Button>
        )}
        {props.busy && props.onStop && !canSend && !recording ? (
          <Button variant="bare" type="button" className="aiSend" data-stop="" aria-label="Stop" onClick={props.onStop}>
            <Square size={14} strokeWidth={0} fill="currentColor" />
          </Button>
        ) : (
          (canSend || !props.mic || props.busy) && (
            <Button variant="bare" type="button" className="aiSend" aria-label="Send" disabled={!canSend} onClick={submit}>
              <ArrowUp size={20} strokeWidth={2.5} />
            </Button>
          )
        )}
      </div>
    </div>
  )
}
