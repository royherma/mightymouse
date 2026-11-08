import { useMemo } from 'react'
import { TOUR } from '../../../shared/tour/constants'
import type { TourSource, TourStepKey } from '../../../shared/tour/types'

// Typed analytics surface for the tour. The App calls track.started() etc. and
// never types an event-name string — names come from TOUR.EVENT, so renaming an
// event is a one-line change in constants.ts. Each method forwards to the
// existing window.api.track → CHANNELS.track → Supabase `events` pipe.
export interface TourAnalytics {
  started: (source: TourSource) => void
  stepViewed: (step: number, key: TourStepKey) => void
  skipped: (step: number) => void
  completed: () => void
  keyConfirmed: (stepKey: TourStepKey, msToPress: number) => void
  keyTimedOut: (stepKey: TourStepKey) => void
  /** Phone-pairing step. Same (stepKey, ms) shape as keyConfirmed so both can
   *  satisfy confirmSession's injected analytics contract. */
  phonePaired: (stepKey: TourStepKey, msToPair: number) => void
  phonePairTimedOut: (stepKey: TourStepKey) => void
}

export function useTourAnalytics(): TourAnalytics {
  return useMemo<TourAnalytics>(
    () => ({
      started: (source) => window.api.track(TOUR.EVENT.started, { source }),
      stepViewed: (step, key) => window.api.track(TOUR.EVENT.stepViewed, { step, key }),
      skipped: (step) => window.api.track(TOUR.EVENT.skipped, { step }),
      completed: () => window.api.track(TOUR.EVENT.completed),
      keyConfirmed: (stepKey, msToPress) =>
        window.api.track(TOUR.EVENT.keyConfirmed, { stepKey, msToPress }),
      keyTimedOut: (stepKey) => window.api.track(TOUR.EVENT.keyTimedOut, { stepKey }),
      phonePaired: (stepKey, msToPair) =>
        window.api.track(TOUR.EVENT.phonePaired, { stepKey, msToPair }),
      phonePairTimedOut: (stepKey) => window.api.track(TOUR.EVENT.phonePairTimedOut, { stepKey })
    }),
    []
  )
}
