import { Button } from '@shared/ui/Button'
// Accessibility is a HOST permission: it gates the trackpad, keys, paste and
// app switching on the Mac. It does not touch the phone's microphone, so this
// is a banner rather than a full-screen state -- dictation still works while
// it's up, and a takeover here would throw that away.
export default function PermissionBanner(props: {
  onOpenSettings: () => void
}): React.JSX.Element {
  return (
    <div className="reconnectBanner">
      <span className="reconnectBannerText">
        Your Mac isn’t accepting input - turn on Accessibility.
      </span>
      <Button variant="bare" className="reconnectBannerBtn" onClick={props.onOpenSettings}>
        Open on Mac
      </Button>
    </div>
  )
}
