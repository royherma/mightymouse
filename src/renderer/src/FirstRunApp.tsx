import { useState, type JSX } from 'react'
import { Check } from 'lucide-react'
import { WindowFrame } from './WindowFrame'
import { Button } from './components/Button'
import { CONFIG } from '../../shared/config'
import { PhonePath } from './first-run/PhonePath'
import './first-run/first-run.css'

function finish(): void {
  void window.api.firstRun.finish('first-run')
}

export default function FirstRunApp(): JSX.Element {
  const [skipped, setSkipped] = useState(false)

  const skip = (): void => {
    window.api.track('ftue_path_picked', { path: 'skip' })
    setSkipped(true)
  }

  if (skipped) {
    return (
      <WindowFrame title={CONFIG.FIRST_RUN.title}>
        <div className="fr">
          <span className="fr-badge fr-badge-done">
            <Check size={24} strokeWidth={3} />
          </span>
          <span className="fr-title">{CONFIG.FIRST_RUN.skipped.title}</span>
          <span className="fr-sub">{CONFIG.FIRST_RUN.skipped.sub}</span>
          <Button variant="primary" className="fr-primary" onClick={finish}>
            {CONFIG.FIRST_RUN.skipped.button}
          </Button>
        </div>
      </WindowFrame>
    )
  }

  return (
    <WindowFrame title={CONFIG.FIRST_RUN.title}>
      <PhonePath path="phone" onDone={finish} onSkip={skip} />
      <div className="fr-foot">
        <Button variant="bare" className="fr-link" onClick={skip}>
          {CONFIG.FIRST_RUN.skipForNow}
        </Button>
      </div>
    </WindowFrame>
  )
}
