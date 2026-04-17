// swift-app/ClaudeNotifier/StatusBarController.swift
// Owns the NSStatusItem, drives frame cycling via Timer, and
// reacts to state changes from StateWatcher.
import AppKit
import Foundation

final class StatusBarController {
    private let item:   NSStatusItem
    private let frames: [String: [NSImage]]
    private let pendingPath: String
    private var watcher:          StateWatcher!
    private var currentState:     String = "idle"
    private var frameIndex:       Int    = 0
    private var celebrationTicks: Int    = 0
    private var cycler:           Timer?

    /// Milliseconds between frame advances per state.
    private static let frameDelay: [String: TimeInterval] = [
        "idle":           0.500,
        "pending_low":    0.250,
        "pending_medium": 0.167,
        "pending_high":   0.100,
        "celebrating":    0.100,
    ]

    /// 4 frames × 3 full cycles = 12 ticks before auto-returning to idle.
    private static let celebMaxTicks = 12

    init(frames: [String: [NSImage]]) {
        self.frames = frames
        self.pendingPath = (NSHomeDirectory() as NSString)
            .appendingPathComponent(".claude-notifier/pending-approval.json")
        self.item   = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        // Show first idle frame immediately
        item.button?.image = frames["idle"]?.first

        // Click → focus source app (VS Code / Terminal / iTerm / Warp)
        item.button?.action = #selector(openTerminal)
        item.button?.target = self

        // Start watching state.json
        watcher = StateWatcher { [weak self] newState in
            self?.handleStateChange(newState)
        }
        watcher.readAndNotify()

        startCycling(for: "idle")
    }

    // ── State handling ────────────────────────────────────────────────────────

    private func handleStateChange(_ newState: String) {
        guard newState != currentState else { return }
        currentState = newState
        startCycling(for: newState)
    }

    private func startCycling(for state: String) {
        cycler?.invalidate()
        frameIndex       = 0
        celebrationTicks = 0

        let stateFrames = frames[state] ?? frames["idle"] ?? []
        guard !stateFrames.isEmpty else { return }

        item.button?.image = stateFrames[0]

        let delay = Self.frameDelay[state] ?? 0.5
        cycler = Timer.scheduledTimer(withTimeInterval: delay, repeats: true) { [weak self] _ in
            guard let self else { return }
            let f = self.frames[state] ?? self.frames["idle"] ?? []
            guard !f.isEmpty else { return }
            self.frameIndex = (self.frameIndex + 1) % f.count
            self.item.button?.image = f[self.frameIndex]

            if state == "celebrating" {
                self.celebrationTicks += 1
                if self.celebrationTicks >= Self.celebMaxTicks {
                    self.currentState = "idle"
                    self.startCycling(for: "idle")
                    self.writeIdleState()
                }
            }
        }
    }

    // ── Click handler ─────────────────────────────────────────────────────────

    @objc private func openTerminal() {
        let source = readPendingSource()
        if focusSourceApp(source) { return }
        _ = focusApp(named: "Visual Studio Code", bundleId: "com.microsoft.VSCode")
            || focusApp(named: "Terminal", bundleId: "com.apple.Terminal")
            || focusApp(named: "iTerm", bundleId: "com.googlecode.iterm2")
            || focusApp(named: "Warp", bundleId: "dev.warp.Warp-Stable")
    }

    private func readPendingSource() -> (app: String?, bundleId: String?, cwd: String?) {
        guard let data = FileManager.default.contents(atPath: pendingPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return (nil, nil, nil)
        }
        return (
            json["sourceApp"] as? String,
            json["sourceBundleId"] as? String,
            json["sourceCwd"] as? String
        )
    }

    private func focusSourceApp(_ source: (app: String?, bundleId: String?, cwd: String?)) -> Bool {
        if let app = source.app, app == "Visual Studio Code", let cwd = source.cwd {
            // Open repo path in VS Code to focus the matching workspace window.
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            proc.arguments = ["-a", app, cwd]
            do {
                try proc.run()
                return true
            } catch {
                return focusApp(named: app, bundleId: source.bundleId)
            }
        }
        if let app = source.app {
            return focusApp(named: app, bundleId: source.bundleId)
        }
        return false
    }

    private func writeIdleState() {
        let statePath = (NSHomeDirectory() as NSString)
            .appendingPathComponent(".claude-notifier/state.json")
        let payload: [String: Any] = ["status": "idle", "pendingCount": 0]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(to: URL(fileURLWithPath: statePath))
    }

    private func focusApp(named appName: String, bundleId: String?) -> Bool {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        if let bundleId,
           NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first != nil {
            proc.arguments = ["-b", bundleId]
        } else {
            proc.arguments = ["-a", appName]
        }
        do {
            try proc.run()
            return true
        } catch {
            return false
        }
    }
}
