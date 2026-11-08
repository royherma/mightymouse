// MmAx.swift — press a control in another app by its accessibility label, and
// prove the press landed.
//
// Consumer: src/main/intent-actions.ts, the closed verb table Siri fires at.
//
// Why this exists rather than a synthesized hotkey: the thing we want to start
// (ChatGPT's voice mode) has a real button with a real AX label, and pressing
// the button needs nothing from the user. A hotkey needs them to bind one in
// the other app first, and then to tell us the same combo a second time -- two
// chances to be wrong, for a worse result. AXPress also survives the button
// moving, being relabelled in the UI, or the window being in the background.
//
// Why a `verify` argument and not just an exit code: AXUIElementPerformAction
// returns .success when the press was DELIVERED, which is not the same as the
// app having done anything. So the caller names what should be true afterwards
// (an element whose label is `verify` exists) and this polls for it. A press
// that delivers but changes nothing exits 3, not 0 -- the distinction the
// caller needs, because "I pressed it" spoken to a user who sees nothing is
// the worst possible answer.
//
// Electron note: ChatGPT is Electron and builds its web AX tree lazily. Setting
// AXManualAccessibility is the documented opt-in; without it the whole web area
// is a single empty group and every search below returns not-found.
//
// Usage:
//   mm-ax press <bundleId> --press <label>[,<label>…] [--verify <label>[,<label>…]]
//                          [--timeout-ms N] [--already <label>[,<label>…]]
//   mm-ax dump  <bundleId> [--grep <substring>] [--timeout-ms N] [--settle-ms N]
//
// `--press` takes several labels because one visible action can have more than
// one button behind it (ChatGPT has a composer button AND a sidebar button);
// they are tried in order and the first one found wins.
//
// `--already` is the idempotence guard: if one of those labels is present
// BEFORE pressing, the desired state already holds and the command exits 0
// with `already`, having pressed nothing. Without it, "start voice mode" said
// twice would press Stop the second time.
//
// Output is one line of JSON on stdout, always. Exit codes: 0 ok/already,
// 1 app not running, 2 bad usage, 3 pressed-but-unverified, 4 control not found.

import AppKit
import ApplicationServices
import Foundation

// MARK: - Output

/// Every exit goes through here: the caller parses one JSON line and never has
/// to scrape prose. `detail` carries whatever the operator needs to debug a
/// failure -- which labels were searched for, how many elements were walked.
func emit(_ status: String, exit code: Int32, detail: [String: Any] = [:]) -> Never {
    var payload: [String: Any] = ["status": status]
    for (k, v) in detail { payload[k] = v }
    if let data = try? JSONSerialization.data(withJSONObject: payload),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    } else {
        print("{\"status\":\"\(status)\"}")
    }
    exit(code)
}

// MARK: - Argument parsing

var args = Array(CommandLine.arguments.dropFirst())
guard let verb = args.first, verb == "press" || verb == "dump" else {
    emit("usage", exit: 2, detail: ["hint": "mm-ax press|dump <bundleId> …"])
}
args.removeFirst()

guard let bundleID = args.first, !bundleID.hasPrefix("--") else {
    emit("usage", exit: 2, detail: ["hint": "missing <bundleId>"])
}
args.removeFirst()

func flag(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
/// Comma-separated so one flag can carry an ordered candidate list.
func labels(_ name: String) -> [String] {
    (flag(name) ?? "").split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
}

let pressLabels = labels("--press")
let verifyLabels = labels("--verify")
let alreadyLabels = labels("--already")
let grep = flag("--grep")?.lowercased()
// 6s: an Electron web AX tree can take a couple of seconds to populate on a
// cold window, and a voice session needs a network round trip before its UI
// settles. Below ~4s this reports false failures on a busy machine.
let timeoutMs = Int(flag("--timeout-ms") ?? "") ?? 6000
let settleMs = Int(flag("--settle-ms") ?? "") ?? 1000

if verb == "press" && pressLabels.isEmpty {
    emit("usage", exit: 2, detail: ["hint": "press needs --press <label>"])
}

// MARK: - The app

guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else {
    emit("not-running", exit: 1, detail: ["bundleId": bundleID])
}
let axApp = AXUIElementCreateApplication(app.processIdentifier)
// Both keys: AXManualAccessibility is what Electron/Chromium honours,
// AXEnhancedUserInterface is the older AppKit-side equivalent. Setting one the
// app ignores is harmless, and which one applies depends on its framework.
AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
// 0.3s while reading the tree — System Settings answered at 40ms a node and one stalled Chrome root took 8.8s. The press itself goes back to the default, because AXPress on a menu blocks until the menu closes.
AXUIElementSetMessagingTimeout(axApp, 0.3)

// MARK: - Tree walking

func attr(_ el: AXUIElement, _ name: String) -> String {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return "" }
    return (value as? String) ?? ""
}

/// All six extra `dump` attributes in one AX round trip instead of six —
/// AXUIElementCopyMultipleAttributeValues is what keeps the per-row cost from
/// scaling with attribute count on a tree this wide.
let dumpAttrNames = [
    kAXDescriptionAttribute, kAXTitleAttribute, kAXHelpAttribute,
    kAXRoleAttribute, kAXPositionAttribute, kAXSizeAttribute,
    kAXValueAttribute, kAXFocusedAttribute, kAXPlaceholderValueAttribute,
    kAXRoleDescriptionAttribute
] as CFArray

struct RawAttrs {
    var description = "", title = "", help = "", role = ""
    var position: CGPoint?
    var size: CGSize?
    var value: CFTypeRef?
    var focused = false
    var placeholder = "", roleDescription = ""
}

func copyAll(_ el: AXUIElement) -> RawAttrs {
    var values: CFArray?
    var out = RawAttrs()
    guard AXUIElementCopyMultipleAttributeValues(el, dumpAttrNames, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
          let list = values as? [AnyObject], list.count == 10
    else { return out }
    func str(_ v: AnyObject) -> String { (v as? String) ?? "" }
    out.description = str(list[0])
    out.title = str(list[1])
    out.help = str(list[2])
    out.role = str(list[3])
    if CFGetTypeID(list[4]) == AXValueGetTypeID() {
        let posVal = list[4] as! AXValue
        if AXValueGetType(posVal) == .cgPoint {
            var p = CGPoint.zero
            if AXValueGetValue(posVal, .cgPoint, &p) { out.position = p }
        }
    }
    if CFGetTypeID(list[5]) == AXValueGetTypeID() {
        let sizeVal = list[5] as! AXValue
        if AXValueGetType(sizeVal) == .cgSize {
            var s = CGSize.zero
            if AXValueGetValue(sizeVal, .cgSize, &s) { out.size = s }
        }
    }
    out.value = list[6]
    out.focused = (list[7] as? Bool) ?? false
    out.placeholder = str(list[8])
    out.roleDescription = str(list[9])
    return out
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &value) == .success
    else { return [] }
    return (value as? [AXUIElement]) ?? []
}

let textInputRoles: Set<String> = [
    "AXTextArea", "AXTextField", "AXSearchField", "AXComboBox", "AXSecureTextField"
]

// dump and press must name a control the same way, or dump offers a field press can never find.
func displayName(_ a: RawAttrs) -> String {
    let name = a.description.isEmpty ? (a.title.isEmpty ? a.help : a.title) : a.description
    if !name.isEmpty || !textInputRoles.contains(a.role) { return name }
    return !a.placeholder.isEmpty ? a.placeholder : (!a.roleDescription.isEmpty ? a.roleDescription : a.role)
}

func collapse(_ s: String) -> String {
    s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

func canPress(_ el: AXUIElement) -> Bool {
    var actions: CFArray?
    guard AXUIElementCopyActionNames(el, &actions) == .success, let list = actions as? [String] else { return false }
    return list.contains(kAXPressAction as String)
}

/// Depth cap, not a visited-set: an AX tree is a tree, but a buggy app can
/// return a child that is its own ancestor and hang the walk. 60 clears the
/// deepest real nesting seen in ChatGPT (~30) with room to spare.
let maxDepth = 60
var walked = 0

// Level by level with a deadline: depth-first, one pass over Finder ran past 40s and never reached the menu bar.
func find(_ root: AXUIElement, _ wanted: Set<String>, pressable: Bool, until deadline: Date) -> (AXUIElement, String)? {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var head = 0
    while head < queue.count, Date() < deadline {
        let (el, depth) = queue[head]
        head += 1
        walked += 1
        let a = copyAll(el)
        let name = collapse(displayName(a))
        if wanted.contains(name), !pressable || textInputRoles.contains(a.role) || canPress(el) {
            return (el, name)
        }
        if depth < maxDepth { for child in children(el) { queue.append((child, depth + 1)) } }
    }
    return nil
}

/// Polls rather than sleeping a fixed amount: the tree appears when it appears,
/// and returning 200ms after it does beats always paying the worst case.
func waitFor(_ wanted: [String], pressable: Bool, ms: Int) -> (AXUIElement, String)? {
    guard !wanted.isEmpty else { return nil }
    let set = Set(wanted.map(collapse))
    let deadline = Date().addingTimeInterval(Double(ms) / 1000)
    repeat {
        walked = 0
        if let hit = find(axApp, set, pressable: pressable, until: deadline) { return hit }
        Thread.sleep(forTimeInterval: 0.2)
    } while Date() < deadline
    return nil
}

// MARK: - dump

// Union of every connected display's frame, in the same top-left global
// points AX itself reports -- a row whose frame falls entirely outside this
// is off-screen chrome (an offscreen scroll buffer, a detached menu), not
// something the loop could ever click.
let screenBounds = NSScreen.screens.map { $0.frame }

func onAnyScreen(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> Bool {
    let flipped = CGRect(x: x, y: y, width: w, height: h)
    return screenBounds.contains { $0.intersects(flipped) }
}

// The display is not the right ruler. Finder's list view reports h=92411, so a
// row 600pt below the window still intersects a tall display and the walk spends
// its whole node budget on file rows it can never click -- measured 5.1s and zero
// pressables against a 1200ms timeout. Clipping to the focused window is what
// keeps the budget on what the user can actually see.
func focusedWindowFrame() -> CGRect? {
    var win: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &win) == .success,
          let w = win, CFGetTypeID(w) == AXUIElementGetTypeID()
    else { return nil }
    let a = copyAll(w as! AXUIElement)
    guard let p = a.position, let s = a.size, s.width > 0, s.height > 0 else { return nil }
    return CGRect(x: p.x, y: p.y, width: s.width, height: s.height)
}

let windowBounds = focusedWindowFrame()

// A slack band so a row peeking in at the edge, or chrome sitting just outside
// the frame (a toolbar, a sheet), still counts as visible.
let VISIBLE_SLACK: Double = 40

func inVisibleRegion(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> Bool {
    guard onAnyScreen(x, y, w, h) else { return false }
    guard let win = windowBounds else { return true }
    return win.insetBy(dx: -VISIBLE_SLACK, dy: -VISIBLE_SLACK)
        .intersects(CGRect(x: x, y: y, width: w, height: h))
}

if verb == "dump" {
    var rows: [[String: Any]] = []
    var offscreen: [[String: Any]] = []
    // Bounds wall-clock, not just row count: filtering out off-screen/empty
    // nodes means many more get walked per row kept than before, so capping
    // only `rows.count` let a deep tree walk unboundedly looking for 400 hits.
    // 700 — measured on Finder, the worst tree here: 400/700/1000/1400 nodes cost
    // 1.18/1.22/1.73/1.94s and returned 16/29/31/31 pressables. Past 700 the curve
    // is flat and the dump blows ui-dump.ts's 1200ms kill.
    let maxWalked = 700
    // Breadth-first, so the budget buys the shallow controls first. Depth-first
    // reached a scroll container early and never came back up for the toolbar.
    var queue: [(AXUIElement, Int)] = []
    func collect(_ el: AXUIElement, _ depth: Int) {
        if depth > maxDepth || rows.count >= 400 || walked >= maxWalked { return }
        walked += 1
        let a = copyAll(el)
        let name = displayName(a)
        if !name.isEmpty, grep == nil || name.lowercased().contains(grep!) {
            let hasFrame = a.position != nil && a.size != nil
            let w = a.size?.width ?? 0
            let h = a.size?.height ?? 0
            let sized = hasFrame && w > 0 && h > 0
            let visible = sized && inVisibleRegion(a.position!.x, a.position!.y, w, h)
            if sized {
                var actions: CFArray?
                AXUIElementCopyActionNames(el, &actions)
                let acts = (actions as? [String]) ?? []
                // AXPress does not need an element to be visible, so a labelled
                // pressable the clip rejected is still reachable -- the only thing
                // it must never do is masquerade as something on screen, because
                // nothing on the capture points at it.
                if visible || (acts.contains(kAXPressAction as String) && offscreen.count < 120) {
                    var row: [String: Any] = [
                        "role": a.role,
                        "label": name,
                        "actions": acts,
                        "frame": ["x": a.position!.x, "y": a.position!.y, "w": w, "h": h],
                        "focused": a.focused
                    ]
                    if a.role != "AXSecureTextField", let str = a.value as? String, !str.isEmpty {
                        row["value"] = String(str.prefix(200))
                    }
                    if visible {
                        rows.append(row)
                    } else {
                        row["offscreen"] = true
                        offscreen.append(row)
                    }
                }
            }
        }
        // A container taller than the window is a scroll buffer: Finder's list
        // view reports 92,430pt, and descending into all ~1000 of its rows spent
        // the whole node budget before the walk ever reached a toolbar button --
        // 5.1s and not one pressable. Its first rows are the ones on screen.
        // A closed menu is zero-sized and so are its items; in Chrome they ate the budget that reaches page buttons (64 -> 170 pressables). An open menu has a real frame and must be walked.
        if a.role == "AXMenu", (a.size?.width ?? 0) == 0 || (a.size?.height ?? 0) == 0 { return }
        var kids = children(el)
        if let win = windowBounds, a.size != nil, a.size!.height > win.height * 2 {
            kids = Array(kids.prefix(60))
        }
        for child in kids { queue.append((child, depth + 1)) }
    }
    // One settle pass: a dump straight after setting AXManualAccessibility on a
    // cold window sees the pre-population tree and reports nothing. Tunable
    // because it is the whole cost of a dump -- the walk itself is ~360ms, so a
    // caller on an already-warm window pays 1s for nothing and blows its budget.
    Thread.sleep(forTimeInterval: Double(settleMs) / 1000)
    queue.append((axApp, 0))
    var head = 0
    // 1.5s — settle 250ms + this + one 0.3s stalled call must land under ui-dump.ts's 2500ms kill, which returns nothing at all.
    let walkDeadline = Date().addingTimeInterval(1.5)
    while head < queue.count, walked < maxWalked, rows.count < 400, Date() < walkDeadline {
        let (el, depth) = queue[head]
        head += 1
        collect(el, depth)
    }
    // Deduped against the visible labels: a control that is also on screen is
    // always the better target, and offering both splits the classifier's vote.
    let seen = Set(rows.compactMap { $0["label"] as? String })
    var offLabels = Set<String>()
    let hidden = offscreen.filter { row in
        guard let label = row["label"] as? String, !seen.contains(label) else { return false }
        return offLabels.insert(label).inserted
    }
    emit("ok", exit: 0, detail: [
        "walked": walked, "count": rows.count, "elements": rows, "timedOut": Date() >= walkDeadline,
        "offscreenCount": hidden.count, "offscreen": hidden
    ])
}

// MARK: - press

// Idempotence first, and it MUST poll rather than walk once. The tree we set
// AXManualAccessibility on a moment ago is still the pre-population one, so a
// single immediate pass finds nothing and falls through to pressing -- which,
// with a session already live, presses the "new session" button and restarts
// what the user was in the middle of. Short budget because this cost is paid on
// every call including the common not-yet-started one, where it buys nothing.
if !alreadyLabels.isEmpty,
   let (_, found) = waitFor(alreadyLabels, pressable: false, ms: min(1500, timeoutMs)) {
    emit("already", exit: 0, detail: ["matched": found, "walked": walked])
}

guard let (button, pressed) = waitFor(pressLabels, pressable: true, ms: timeoutMs) else {
    emit("not-found", exit: 4, detail: ["searched": pressLabels, "walked": walked])
}

// A native text field has no AXPress (Finder search: AXShowMenu, AXConfirm), so focusing it is the press.
AXUIElementSetMessagingTimeout(axApp, 0)
let result = canPress(button)
    ? AXUIElementPerformAction(button, kAXPressAction as CFString)
    : AXUIElementSetAttributeValue(button, kAXFocusedAttribute as CFString, kCFBooleanTrue)
AXUIElementSetMessagingTimeout(axApp, 0.3)
guard result == .success else {
    emit("press-failed", exit: 3, detail: ["matched": pressed, "axError": result.rawValue])
}

// No --verify means the caller accepts delivery as the answer. Every caller
// that can name a post-condition should pass one.
if verifyLabels.isEmpty {
    emit("ok", exit: 0, detail: ["pressed": pressed, "verified": false])
}

// pressable:false — a post-condition is often an image or a static label
// ("Voice chat active"), which is exactly the thing that cannot be pressed.
if let (_, confirmed) = waitFor(verifyLabels, pressable: false, ms: timeoutMs) {
    emit("ok", exit: 0, detail: ["pressed": pressed, "verified": true, "confirmedBy": confirmed])
}

emit("unverified", exit: 3, detail: ["pressed": pressed, "expected": verifyLabels])
