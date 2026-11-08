import type { InputHTMLAttributes, JSX } from 'react'

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <input
      {...rest}
      className={`w-full min-h-8 rounded-md bg-surface2 border border-surface3 px-3 py-1 text-md text-on-surface placeholder:text-muted outline-none focus:border-accent ${className}`}
    />
  )
}
