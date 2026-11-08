import type { ButtonHTMLAttributes, JSX, Ref } from 'react'
import { Loader2 } from 'lucide-react'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'text'
  | 'success'
  | 'danger'
  | 'icon'
  | 'quiet'
  | 'bare'
export type ButtonSize = 'md' | 'lg'

const CHROME =
  'cursor-pointer disabled:cursor-default outline-none focus-visible:shadow-focus'
const FRAME: Record<ButtonSize, string> = {
  md: `min-h-8 rounded-sm px-3.5 py-1 text-md font-semibold ${CHROME}`,
  lg: `inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-md font-semibold ${CHROME}`
}
const ICON = `inline-flex min-h-8 min-w-8 items-center justify-center rounded-sm p-1.5 ${CHROME}`
const QUIET = `inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-sm ${CHROME}`
// :where() keeps bare at zero specificity - a call site's own border, bg, font or cursor class must win
const BARE =
  '[:where(&)]:cursor-pointer disabled:cursor-default outline-none focus-visible:shadow-focus'

const FILLED = 'border-0 transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-50'

const VARIANT: Record<ButtonVariant, string> = {
  primary: `bg-accent text-on-accent ${FILLED}`,
  success: `bg-green text-on-accent ${FILLED}`,
  danger: `bg-red text-on-accent ${FILLED}`,
  secondary:
    'bg-surface2 text-on-surface border-0 transition-colors hover:bg-surface3 disabled:opacity-50',
  ghost:
    'bg-transparent border border-surface3 text-muted transition-colors hover:bg-surface3 hover:text-on-surface active:brightness-95 disabled:opacity-50',
  text: 'bg-transparent border-0 text-muted transition-colors hover:text-on-surface disabled:opacity-50',
  icon:
    'border border-surface3 bg-transparent text-muted transition-colors hover:bg-surface3 hover:text-on-surface',
  quiet:
    'border-0 bg-transparent text-muted transition-[background-color,color,transform] duration-150 hover:bg-surface3 hover:text-on-surface active:scale-95 disabled:opacity-50',
  bare: '[:where(&)]:border-0 [:where(&)]:bg-transparent [:where(&)]:font-normal [:where(&)]:text-inherit'
}

export function Button({
  variant = 'primary',
  size = 'md',
  busy = false,
  className = '',
  type = 'button',
  disabled,
  ref,
  children,
  ...rest
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  busy?: boolean
  ref?: Ref<HTMLButtonElement>
} & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  const frame =
    variant === 'icon' ? ICON : variant === 'quiet' ? QUIET : variant === 'bare' ? BARE : FRAME[size]
  return (
    <button
      ref={ref}
      type={type}
      data-button-variant={variant}
      disabled={disabled || busy}
      className={`${frame} ${VARIANT[variant]} ${className}`.trim()}
      {...rest}
    >
      {busy && <Loader2 size={16} className="animate-spin" />}
      {children}
    </button>
  )
}
