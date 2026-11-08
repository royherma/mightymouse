import type React from 'react'
import appIcon from '../assets/app-icon.png'
import { ProviderIcon as SharedProviderIcon, providerIconFor, type ProviderIconId } from '../../../shared/provider-icon'

export { providerIconFor, type ProviderIconId }

export function ProviderIcon({ id, size = 22 }: { id: ProviderIconId; size?: number }): React.ReactElement {
  if (id === 'mightymouse') return <img src={appIcon} width={size} height={size} alt="" className="shrink-0 rounded-[24%]" />
  return <SharedProviderIcon id={id} size={size} />
}
