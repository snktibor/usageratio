import AppKit
import SwiftUI

/// The menu bar app: the chosen provider's usage percentage in the menu bar,
/// the details in a popover. No Dock icon, no windows (LSUIElement).
@main
struct UsageRatioBarApp: App {
    @State private var store = StatusStore()

    init() {
        // Info.plist's LSUIElement does this in the .app; `swift run` has no Info.plist.
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    var body: some Scene {
        MenuBarExtra {
            PopoverView(store: store)
        } label: {
            MenuBarLabel(store: store)
        }
        .menuBarExtraStyle(.window)
    }
}
