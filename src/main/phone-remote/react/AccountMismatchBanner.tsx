import { Button } from '@shared/ui/Button'
export default function AccountMismatchBanner(props: { onDisconnect: () => void }): React.JSX.Element {
  return (
    <div className="reconnectBanner" role="status">
      <span className="reconnectBannerText">
        This Mac is signed in to a different MightyMouse account than your phone.
      </span>
      <Button variant="bare" className="reconnectBannerBtn" onClick={props.onDisconnect}>
        Disconnect
      </Button>
    </div>
  )
}
