import SwiftUI

@main
struct MightyMouseApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                // Pinned deliberately: THEME_TOKENS is a single light palette and
                // no MightyMouse surface ships a dark scheme, so following the
                // system would put dark chrome around our light canvas. Unpin this
                // only when the shared tokens gain a real dark set.
                .preferredColorScheme(.light)
                .task {
                    BackgroundActivity.endOrphans()
                    RecordingQueue.sweepOrphanFiles()
                    Analytics.shared.startFlushLoop()
                    Analytics.shared.startCrashReporting()
                    // Every launch, not once: a rotated/stale token has to
                    // self-heal with no user action.
                    // Token only -- the PROMPT waits for a connected Mac, see
                    // PushRegistration.requestOnFirstConnection.
                    PushRegistration.registerIfAuthorized()
                }
                // The Meta AI app finishes glasses registration by opening our
                // scheme. DAT claims the URL or it isn't one of ours.
                #if MM_GLASSES
                .onOpenURL { url in
                    Task { _ = await GlassesSession.shared.handleCallback(url) }
                }
                #endif
        }
        // scenePhase rather than an init() one-shot: the launch event has to fire
        // on every foreground to be a DAU signal, and a cold launch is just the
        // first of those. Analytics debounces the rest.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Analytics.shared.trackForeground() }
            // Photo ids live for ONE foreground session. Not a
            // cache expiry: a stable id is a durable handle on someone's photo
            // library, so it stops meaning anything the moment we leave.
            if phase == .background { PhotoLibrary.endSession() }
        }
    }
}
