import WidgetKit
import SwiftUI

/// How long a `hostStatus` push may age before the tile stops calling it
/// live. Matches the Mac's own throttle floor (config.ts
/// HOST_STATUS_THROTTLE_MS) plus slack for one missed background push --
/// past this, a value on screen would be an outright lie about "now".
private let STALE_AFTER: TimeInterval = 3 * 60

struct HostStatusEntry: TimelineEntry {
    let date: Date
    let batteryPercent: Int?
    let charging: Bool
    let hostname: String
    let at: Date?

    /// No `asleep` field ever crosses the wire (ios/CLAUDE.md: Swift owns no
    /// connection state) -- staleness is derived here, from the entry's own
    /// age at render time, same reasoning as ReconnectBanner.tsx's silence-
    /// based read of "the Mac itself is asleep or quit".
    var isStale: Bool {
        guard let at else { return true }
        return date.timeIntervalSince(at) > STALE_AFTER
    }
}

struct HostStatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> HostStatusEntry {
        HostStatusEntry(date: Date(), batteryPercent: 82, charging: false, hostname: "Roy's Mac", at: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (HostStatusEntry) -> Void) {
        completion(readEntry())
    }

    /// Refreshes every minute even with no new push, purely so the "X ago" age
    /// on screen keeps counting up and the stale cutover fires on time --
    /// WidgetKit does not re-render a static entry on its own.
    func getTimeline(in context: Context, completion: @escaping (Timeline<HostStatusEntry>) -> Void) {
        let entry = readEntry()
        let nextRefresh = Calendar.current.date(byAdding: .minute, value: 1, to: Date()) ?? Date()
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }

    private func readEntry() -> HostStatusEntry {
        let defaults = SharedAppGroup.defaults
        let atMs = defaults.double(forKey: SharedAppGroup.hostStatusAtKey)
        return HostStatusEntry(
            date: Date(),
            batteryPercent: defaults.object(forKey: SharedAppGroup.hostBatteryPercentKey) as? Int,
            charging: defaults.bool(forKey: SharedAppGroup.hostChargingKey),
            hostname: defaults.string(forKey: SharedAppGroup.hostNameKey) ?? "",
            at: atMs > 0 ? Date(timeIntervalSince1970: atMs / 1000) : nil
        )
    }
}

/// Deep link the whole tile opens. There is no in-app router to target: the app
/// lands on the deck by itself whenever `remoteURL` resolves (AppModel.live), so
/// this exists to make the widget a tap target at all, not to pick a screen.
let hostStatusWidgetURL = URL(string: "mightymouse://deck")!

struct HostStatusWidgetView: View {
    @Environment(\.widgetFamily) private var family
    /// StandBy at night and the Lock Screen both render `.vibrant`, which
    /// flattens colour to a luminance mask -- a Gauge's track survives that as
    /// a washed-out ring the eye reads as an empty battery. Swap it for the
    /// glyph+text row those modes render cleanly.
    @Environment(\.widgetRenderingMode) private var renderingMode
    var entry: HostStatusEntry

    private var isVibrant: Bool { renderingMode == .vibrant }

    /// EVERY family must declare a container background, not just the system
    /// ones -- a family that omits it is not rendered plain, it is replaced
    /// wholesale by the system's "Please adopt containerBackground" error tile.
    ///
    /// Unconditional on purpose: this closure is evaluated before the
    /// environment resolves, so branching on `widgetFamily` here picks one
    /// branch for every family and leaves the rest with a background the
    /// system rejects. `.fill.tertiary` is ignored by the accessory families
    /// (the Lock Screen draws its own material), so one declaration is right
    /// for all five.
    var body: some View {
        content
            .widgetURL(hostStatusWidgetURL)
            .containerBackground(.fill.tertiary, for: .widget)
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryCircular: circular
        case .accessoryRectangular: rectangular
        case .accessoryInline: Label(inlineText, systemImage: glyph)
        case .systemMedium: medium
        default: small
        }
    }

    // MARK: - System families

    private var small: some View {
        ZStack {
            glowField(radius: 150)
            VStack(spacing: MMSpace.one) {
                pingStamp
                    .frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 0)
                batteryRing(diameter: 58)
                Spacer(minLength: 0)
                statusLine()
            }
            .padding(MMSpace.three)
        }
    }

    /// The extra width is a second column, not a wider first one: the ring keeps
    /// its size and the freed space carries the action buttons, which the small
    /// family has no room for at all.
    private var medium: some View {
        ZStack {
            glowField(radius: 220)
            HStack(spacing: MEDIUM_COLUMN_GAP) {
                VStack(alignment: .leading, spacing: MMSpace.two) {
                    VStack(alignment: .leading, spacing: MMSpace.one) {
                        pingStamp
                        statusLine(size: MMFont.lg)
                    }
                    actions
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                batteryRing(diameter: 76)
            }
            .padding(MMSpace.three)
        }
    }

    /// Tinted by CONNECTION, not battery -- the glow reads at a glance from the
    /// home screen, so it carries the same signal as the stamp dot rather than
    /// competing with the ring's battery colour.
    ///
    /// `ignoresSafeArea` + an infinite frame are both required: a RadialGradient
    /// has no intrinsic size, so inside a ZStack it is laid out to the sibling
    /// content's bounds and stops in a hard edge short of the tile corners.
    private func glowField(radius: CGFloat) -> some View {
        RadialGradient(
            colors: [connectionColor.opacity(0.30), .clear],
            center: .topLeading, startRadius: 0, endRadius: radius
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea()
    }

    private var connectionColor: Color {
        entry.isStale ? MMColor.grayMuted : MMColor.green
    }

    /// Battery-level colour, the convention every phone already teaches:
    /// green healthy, amber getting low, red act now. Charging overrides it --
    /// a 9% Mac on the charger is not a problem to flag.
    private var batteryColor: Color {
        if entry.isStale { return MMColor.grayMuted }
        if entry.charging { return MMColor.green }
        switch entry.batteryPercent ?? 100 {
        case ..<15: return MMColor.red
        case ..<35: return MMColor.orange
        default: return MMColor.green
        }
    }

    /// The "last pinged" freshness stamp. Computed per render rather than using
    /// `Text(_:style: .relative)`, which spells out "1 min, 47 sec" and both
    /// overflows the small tile and reads as precision nobody asked for. The
    /// provider's 1-minute refresh keeps this current.
    @ViewBuilder
    private var pingStamp: some View {
        if let at = entry.at {
            HStack(spacing: MMSpace.one) {
                Circle()
                    .fill(connectionColor)
                    .frame(width: 6, height: 6)
                Text(agoLabel(since: at))
                    .font(.system(size: MMFont.micro, weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(MMColor.grayMuted)
        }
    }

    private func agoLabel(since at: Date) -> String {
        let seconds = Int(entry.date.timeIntervalSince(at))
        switch seconds {
        case ..<60: return "Now"
        case ..<3600: return "\(seconds / 60)m ago"
        case ..<86_400: return "\(seconds / 3600)h ago"
        default: return "\(seconds / 86_400)d ago"
        }
    }

    private func batteryRing(diameter: CGFloat) -> some View {
        ZStack {
            Circle()
                .stroke(batteryColor.opacity(0.18), lineWidth: 7)
            Circle()
                .trim(from: 0, to: CGFloat(entry.batteryPercent ?? 0) / 100)
                .stroke(batteryColor, style: StrokeStyle(lineWidth: 7, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                if let percent = entry.batteryPercent {
                    Text("\(percent)")
                        .font(.system(size: MMFont.xl, weight: .bold, design: .rounded))
                } else {
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: MMFont.mlg))
                }
                if entry.charging {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: MMFont.micro))
                        .foregroundStyle(batteryColor)
                }
            }
        }
        .frame(width: diameter, height: diameter)
    }

    /// `.primary`, not MMColor.onSurface: Theme.swift is generated from the LIGHT
    /// palette, so onSurface is a near-black that vanishes on the dark material a
    /// widget actually renders on. Only the stale branch was visible before
    /// because grayMuted happens to read on both.
    private func statusLine(size: CGFloat = MMFont.xs) -> some View {
        Text(entry.isStale ? "Not connected" : (entry.hostname.isEmpty ? "Mac" : entry.hostname))
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(entry.isStale ? MMColor.grayMuted : Color.primary)
            .lineLimit(1)
    }

    /// Both intents only ever set an App Group flag and return -- the app acts
    /// on it once foregrounded (`ControlWidgets.swift`), so neither needs the
    /// Mac reachable at tap time and both work from a stale tile.
    /// Ask is the primary action and carries the brand accent; Record is the
    /// rarer, heavier one and reads as secondary. Tinting both identically made
    /// the pair look like one control split in half.
    private var actions: some View {
        HStack(spacing: 6) {
            Button(intent: ArmAskIntent()) {
                Label("Ask", systemImage: "text.bubble")
                    .font(.caption)
            }
            .tint(MMColor.accent)
            Button(intent: StartRecordingIntent()) {
                Label("Record", systemImage: "mic.fill")
                    .font(.caption)
            }
            .tint(MMColor.red)
        }
        .buttonStyle(.bordered)
        .labelStyle(.titleAndIcon)
    }

    // MARK: - Accessory families (Lock Screen + StandBy-adjacent)

    /// A ring showing a stale percentage would be the exact lie STALE_AFTER
    /// exists to prevent, and the circular family has no room for an age --
    /// so staleness renders as a slashed glyph with no number at all.
    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            if entry.isStale {
                Image(systemName: "wifi.slash")
                    .font(.title3)
            } else if let percent = entry.batteryPercent, !isVibrant {
                Gauge(value: Double(percent), in: 0...100) {
                    Image(systemName: entry.charging ? "bolt.fill" : "desktopcomputer")
                } currentValueLabel: {
                    Text("\(percent)")
                }
                .gaugeStyle(.accessoryCircularCapacity)
            } else if let percent = entry.batteryPercent {
                VStack(spacing: 0) {
                    Image(systemName: entry.charging ? "bolt.fill" : "desktopcomputer")
                        .font(.caption2)
                    Text("\(percent)%")
                        .font(.caption)
                }
            } else {
                Image(systemName: "desktopcomputer")
                    .font(.title3)
            }
        }
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(entry.hostname.isEmpty ? "Mac" : entry.hostname)
                .font(.headline)
                .lineLimit(1)
            Label(inlineText, systemImage: glyph)
                .font(.caption)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    /// One line, no glyph of its own -- the caller supplies the symbol, and
    /// `.accessoryInline` strips styling anyway.
    private var inlineText: String {
        guard !entry.isStale else { return "Not connected" }
        guard let percent = entry.batteryPercent else { return "Connected" }
        return "\(percent)%\(entry.charging ? " charging" : "")"
    }

    private var glyph: String {
        if entry.isStale { return "wifi.slash" }
        guard let percent = entry.batteryPercent else { return "desktopcomputer" }
        return entry.charging ? "battery.100.bolt" : batteryIcon(percent)
    }

    // MARK: - Shared pieces

    private func batteryIcon(_ percent: Int) -> String {
        switch percent {
        case ..<15: return "battery.0"
        case ..<40: return "battery.25"
        case ..<65: return "battery.50"
        case ..<90: return "battery.75"
        default: return "battery.100"
        }
    }
}

private let MEDIUM_COLUMN_GAP: CGFloat = 12

struct HostStatusWidget: Widget {
    let kind = "HostStatusWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: HostStatusProvider()) { entry in
            HostStatusWidgetView(entry: entry)
        }
        .configurationDisplayName("Mac Status")
        .description("Battery and connection state for your Mac.")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .accessoryCircular,
            .accessoryRectangular,
            .accessoryInline,
        ])
    }
}
