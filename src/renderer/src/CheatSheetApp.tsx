import { JSX } from 'react'
import { CONFIG } from '../../shared/config'
import { VISIBLE_SHORTCUTS, comboGlyphs } from '../../shared/shortcuts'
import { Kbd } from './components/Kbd'
import { Card } from './components/Card'
import { Row } from './components/Layout'
import { WindowFrame } from './WindowFrame'

export default function CheatSheetApp(): JSX.Element {
  return (
    <WindowFrame title={`${CONFIG.BRAND_ICON} ${CONFIG.APP_NAME} Shortcuts`}>
      <div className="px-6 pb-6 pt-5">
        <p className="text-muted text-md mb-4">
          Global shortcuts. They work anywhere, in any app.
        </p>

        {VISIBLE_SHORTCUTS.map((s) => (
          <Card key={s.id}>
            <Row gap={3} className="justify-between">
              <span className="text-md font-semibold" title={`${s.desc} ${s.tips}`}>{s.title}</span>
              <Kbd glyphs={comboGlyphs(s)} />
            </Row>
          </Card>
        ))}
      </div>
    </WindowFrame>
  )
}
