import type { JSX } from 'react'
import { WindowFrame } from './WindowFrame'
import { ActionsSettingsSection } from './components/ActionsSettingsSection'
import { CONFIG } from '../../shared/config'

export default function ActionsApp(): JSX.Element {
  return (
    <WindowFrame title={`${CONFIG.APP_NAME} Actions`}>
      <div className="p-5 max-w-[640px] mx-auto">
        <ActionsSettingsSection bare />
      </div>
    </WindowFrame>
  )
}
