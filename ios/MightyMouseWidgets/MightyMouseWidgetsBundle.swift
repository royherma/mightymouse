import WidgetKit
import SwiftUI

@main
struct MightyMouseWidgetsBundle: WidgetBundle {
    var body: some Widget {
        AskMightyControl()
        RecordControl()
        HostStatusWidget()
        BackgroundActivityWidget()
    }
}
