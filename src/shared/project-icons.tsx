import React from 'react'
import {
  Folder,
  Rocket,
  Globe,
  Smartphone,
  Terminal,
  Palette,
  Database,
  Bot,
  Camera,
  ShoppingCart,
  Music,
  Beaker,
  type LucideIcon
} from 'lucide-react'

/** The icons a project can be marked with, in the order the picker shows them.
 *  `folder` leads because it is what every project has until someone picks. */
export const PROJECT_ICONS: ReadonlyArray<{ id: string; label: string; icon: LucideIcon }> = [
  { id: 'folder', label: 'Folder', icon: Folder },
  { id: 'rocket', label: 'Launch', icon: Rocket },
  { id: 'globe', label: 'Website', icon: Globe },
  { id: 'phone', label: 'Mobile app', icon: Smartphone },
  { id: 'terminal', label: 'Command line', icon: Terminal },
  { id: 'palette', label: 'Design', icon: Palette },
  { id: 'database', label: 'Data', icon: Database },
  { id: 'bot', label: 'Agent', icon: Bot },
  { id: 'camera', label: 'Video', icon: Camera },
  { id: 'cart', label: 'Store', icon: ShoppingCart },
  { id: 'music', label: 'Audio', icon: Music },
  { id: 'beaker', label: 'Experiment', icon: Beaker }
]

const BY_ID = new Map(PROJECT_ICONS.map((i) => [i.id, i.icon]))

export function ProjectIcon({ id, size = 12 }: { id?: string; size?: number }): React.ReactElement {
  const Icon = (id && BY_ID.get(id)) || Folder
  return <Icon size={size} strokeWidth={2} aria-hidden />
}
