import { JSX, useMemo } from 'react'
import { SpecialistPanel } from '../../shared/support/SpecialistChat'
import type { SupportClient } from '../../shared/support/types'

export default function SpecialistApp(): JSX.Element {
  const client = useMemo<SupportClient>(
    () => ({
      load: () => window.api.specialistLoad(),
      send: (body) => window.api.specialistSend(body),
      subscribe: (onChange) => window.api.onSpecialistChanged(onChange)
    }),
    []
  )
  return (
    <div className="h-screen font-sans">
      <SpecialistPanel client={client} insetTop />
    </div>
  )
}
