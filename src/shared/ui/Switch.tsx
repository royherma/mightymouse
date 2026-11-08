import type { JSX } from 'react'
import * as RadixSwitch from '@radix-ui/react-switch'

export function Switch({
  on,
  onChange,
  label
}: {
  on: boolean
  onChange: (next: boolean) => void
  label?: string
}): JSX.Element {
  return (
    <RadixSwitch.Root
      checked={on}
      onCheckedChange={onChange}
      aria-label={label}
      className="w-11 h-6 rounded-full shrink-0 cursor-pointer transition-colors outline-none data-[state=checked]:bg-accent data-[state=unchecked]:bg-surface3 data-[state=checked]:shadow-focus focus-visible:shadow-focus"
    >
      <RadixSwitch.Thumb className="block w-5 h-5 ml-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-5" />
    </RadixSwitch.Root>
  )
}
