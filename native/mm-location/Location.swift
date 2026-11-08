import AppKit
import CoreLocation
final class D: NSObject, CLLocationManagerDelegate {
  let m = CLLocationManager()
  override init() { super.init(); m.delegate = self; m.desiredAccuracy = kCLLocationAccuracyBest }
  func out(_ s: String) -> Never { print(s); fflush(stdout); exit(0) }
  func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
    switch m.authorizationStatus {
    case .notDetermined: m.requestWhenInUseAuthorization()
    case .denied, .restricted: out("{\"error\":\"denied\"}")
    default: m.requestLocation()
    }
  }
  func locationManager(_ m: CLLocationManager, didUpdateLocations l: [CLLocation]) {
    guard let c = l.last else { return }
    out("{\"latitude\":\(c.coordinate.latitude),\"longitude\":\(c.coordinate.longitude),\"accuracy\":\(c.horizontalAccuracy)}")
  }
  func locationManager(_ m: CLLocationManager, didFailWithError e: Error) { out("{\"error\":\"\((e as NSError).code)\"}") }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let d = D()
DispatchQueue.main.asyncAfter(deadline: .now() + 60) { d.out("{\"error\":\"timeout\"}") }
app.run()
