import AppIntents
import SwiftUI
import WidgetKit

// Both intents these buttons run are declared in `Intents.swift`, which is a
// member of the app target too. Declaring them here instead makes every tap
// fail with LNContextErrorDomain 2001 -- see the note there before moving them.

// ControlWidgetConfigurationBuilder has no multi-content buildBlock (unlike
// WidgetBundleBuilder), so one ControlWidget = one StaticControlConfiguration.
struct AskMightyControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.mightymouse.ios.widgets.controls") {
            ControlWidgetButton(action: ArmAskIntent()) {
                Label("Ask Mighty", systemImage: "text.bubble")
            }
        }
        .displayName("Ask Mighty")
        .description("Open MightyMouse and ask a question.")
    }
}

struct RecordControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.mightymouse.ios.widgets.record") {
            ControlWidgetButton(action: StartRecordingIntent()) {
                Label("Record", systemImage: "mic.fill")
            }
        }
        .displayName("Record")
        .description("Open MightyMouse and start recording a note.")
    }
}
