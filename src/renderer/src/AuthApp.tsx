import { useEffect, useRef, useState, JSX } from 'react'
import { CONFIG } from '../../shared/config'
import { Badge } from './components/Badge'
import { Button } from './components/Button'
import { Spinner } from './components/Spinner'

// Two sign-in modes share the same Supabase users table:
//  - 'code' (default): email + 6-digit code. One field, no password to invent
//    or remember — the lowest-friction path, and the one we put people on.
//  - 'password': kept as a fallback for when email delivery is slow or the code
//    doesn't arrive, so a bad inbox day can never lock someone out.
type Mode = 'code' | 'password'
type Step = 'enter' | 'code'

export default function AuthApp(): JSX.Element {
  const [mode, setMode] = useState<Mode>('code')
  const [step, setStep] = useState<Step>('enter')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [signedIn, setSignedIn] = useState(false)
  const [resendIn, setResendIn] = useState(0)
  const codeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus()
  }, [step])

  useEffect(() => {
    if (resendIn <= 0) return
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [resendIn])

  // Pre-fill the email from a landing-page download handoff (deeplink → main).
  // One-shot: reading it clears it in main, so this only pre-fills the first
  // sign-in after a gated download. Never overwrites an email the user typed.
  useEffect(() => {
    void window.api.auth.takePendingEmail().then((pending) => {
      if (pending) setEmail((cur) => cur || pending)
    })
  }, [])

  async function handlePassword(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    const res = await window.api.auth.password(email, password)
    setBusy(false)
    if (res.ok) setSignedIn(true)
    else setError(res.error || 'Sign-in failed.')
    // On success, main closes this window via onAuthed.
  }

  async function handleSendCode(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    const res = await window.api.auth.sendCode(email)
    setBusy(false)
    if (res.ok) {
      setStep('code')
      setResendIn(CONFIG.AUTH_RESEND_COOLDOWN_S)
    } else setError(res.error || 'Could not send the code.')
  }

  async function handleResend(): Promise<void> {
    if (busy || resendIn > 0) return
    setError('')
    setBusy(true)
    const res = await window.api.auth.sendCode(email)
    setBusy(false)
    if (res.ok) setResendIn(CONFIG.AUTH_RESEND_COOLDOWN_S)
    else setError(res.error || 'Could not send the code.')
  }

  async function verify(token: string): Promise<void> {
    if (busy) return
    setError('')
    setBusy(true)
    const res = await window.api.auth.verifyCode(email, token)
    setBusy(false)
    if (res.ok) {
      setSignedIn(true)
      return
    }
    setError('That code did not work. Use the newest email, or ask for a new code.')
    setCode('')
    codeRef.current?.focus()
  }

  function handleVerify(e: React.FormEvent): void {
    e.preventDefault()
    void verify(code)
  }

  // Token-backed Tailwind classes (no inline-style blobs, no raw hex). The form
  // fields are larger than SettingsApp's compact inputs — this is a focused CTA
  // screen, so the bigger rounded inputs/buttons are intentional.
  const inputCls =
    'w-full px-3.5 py-3 rounded-[10px] border border-surface3 bg-surface1 text-on-surface text-[15px] outline-none box-border focus:border-accent focus:shadow-focus transition-colors'
  const linkCls = 'text-muted text-[13px]'

  const onCodeStep = mode === 'code' && step === 'code'
  const errorLine = <div className="min-h-[36px] text-magenta text-[13px] text-center">{error}</div>

  if (signedIn) {
    return (
      <div className="w-full h-screen flex flex-col items-center justify-center gap-4 px-7 py-8 box-border bg-bg text-on-surface font-sans">
        <div className="text-[34px]">{CONFIG.BRAND_ICON}</div>
        <Spinner size="w-5 h-5" />
        <div className="text-xl font-bold">Signed in. Opening {CONFIG.APP_NAME}...</div>
      </div>
    )
  }

  return (
    <div className="w-full h-screen flex flex-col items-center justify-center gap-4 px-7 py-8 box-border bg-bg text-on-surface font-sans">
      <div className="text-[34px]">{CONFIG.BRAND_ICON}</div>
      <div className="text-xl font-bold">
        {onCodeStep ? 'Enter your code' : `Sign in to ${CONFIG.APP_NAME}`}
      </div>
      {/* Staging-only marker so it's obvious you're signing into the test backend. */}
      {CONFIG.IS_STAGING && (
        <Badge color="amber">
          <span>●</span>
          <span>{CONFIG.ENV_NAME.toUpperCase()}</span>
        </Badge>
      )}
      <div className="text-[13px] text-muted text-center max-w-[300px]">
        {onCodeStep
          ? `Sent to ${email}. Check your inbox and spam folder.`
          : mode === 'code'
            ? 'Enter your email and we will send you a 6-digit code. New here? Your account is created automatically.'
            : 'Sign in with your email and password. New here? We create your account automatically.'}
      </div>

      {mode === 'password' && (
        <form onSubmit={handlePassword} className="w-full grid gap-3">
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            className={inputCls}
          />
          <input
            type="password"
            placeholder="Password (6 or more characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
          {errorLine}
          <Button size="lg" type="submit" className="w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Continue'}
          </Button>
          <Button variant="bare" onClick={() => { setMode('code'); setError('') }} className={linkCls}>
            Back to signing in with a code
          </Button>
        </form>
      )}

      {mode === 'code' && step === 'enter' && (
        <form onSubmit={handleSendCode} className="w-full grid gap-3">
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            className={inputCls}
          />
          {errorLine}
          <Button size="lg" type="submit" className="w-full" disabled={busy}>
            {busy ? 'Sending…' : 'Send code'}
          </Button>
        </form>
      )}

      {onCodeStep && (
        <form onSubmit={handleVerify} className="w-full grid gap-3">
          <input
            ref={codeRef}
            type="text"
            inputMode="numeric"
            placeholder="123456"
            value={code}
            maxLength={6}
            onChange={(e) => {
              const next = e.target.value.replace(/\D/g, '')
              setCode(next)
              if (next.length === 6) void verify(next)
            }}
            className={`${inputCls} text-center text-[22px] tracking-[8px]`}
          />
          {errorLine}
          <Button size="lg" type="submit" className="w-full" disabled={busy}>
            {busy ? 'Verifying…' : 'Verify & sign in'}
          </Button>
          <div className={`${linkCls} flex items-center justify-center gap-1`}>
            <span>{"Didn't get the code?"}</span>
            <Button variant="bare" onClick={() => void handleResend()} disabled={busy || resendIn > 0} className={linkCls}>
              {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
            </Button>
            <Button variant="bare" onClick={() => { setMode('password'); setError('') }} className={linkCls}>
              Use a password
            </Button>
          </div>
          <Button
            variant="bare"
            onClick={() => { setStep('enter'); setCode(''); setError('') }}
            className={linkCls}
          >
            Use a different email
          </Button>
        </form>
      )}
    </div>
  )
}
