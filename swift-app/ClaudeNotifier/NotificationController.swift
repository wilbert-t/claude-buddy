// swift-app/ClaudeNotifier/NotificationController.swift
import Foundation
import AppKit
import UserNotifications

final class NotificationController: NSObject, UNUserNotificationCenterDelegate {
    private let notifierDir: String

    static let categoryId        = "ALERT"
    static let openTerminalAction = "OPEN_TERMINAL"

    /// Maps notification id → (sourceBundleId, sourceApp) so tapping "Open Terminal"
    /// knows which app to bring to front.
    private var pendingSourceInfo: [String: (bundleId: String?, app: String?)] = [:]


    override init() {
        self.notifierDir = (NSHomeDirectory() as NSString)
            .appendingPathComponent(".claude-notifier")
        super.init()
        configureNotificationAppIcon()
        registerCategory()
    }

    // MARK: – Register notification category

    private func registerCategory() {
        let openTerminal = UNNotificationAction(
            identifier: Self.openTerminalAction,
            title: "Open Terminal",
            options: [.foreground]
        )
        let category = UNNotificationCategory(
            identifier: Self.categoryId,
            actions: [openTerminal],
            intentIdentifiers: [],
            options: []
        )
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([category])

        center.getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                switch settings.authorizationStatus {
                case .authorized, .provisional:
                    self?.log("Notifications: already authorized ✓")
                case .notDetermined:
                    NSApp.setActivationPolicy(.regular)
                    NSApp.activate(ignoringOtherApps: true)
                    center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, error in
                        DispatchQueue.main.async {
                            NSApp.setActivationPolicy(.accessory)
                            if let error = error {
                                self?.log("Notifications: auth error — \(error.localizedDescription)")
                            } else if granted {
                                self?.log("Notifications: permission granted ✓")
                            } else {
                                self?.log("Notifications: DENIED — open System Settings > Notifications > Claude Code Notifier and enable alerts")
                            }
                        }
                    }
                case .denied:
                    self?.log("Notifications: DENIED — open System Settings > Notifications > Claude Code Notifier and enable alerts")
                @unknown default:
                    center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
                }
            }
        }
    }

    // MARK: – Notification app icon

    private func configureNotificationAppIcon() {
        guard let bundledIconPath = Bundle.main.path(forResource: "NotificationIcon", ofType: "png"),
              let image = NSImage(contentsOfFile: bundledIconPath) else {
            log("Notification app icon not found — using default placeholder")
            return
        }
        NSApp.applicationIconImage = image
    }

    // MARK: – Show alert notification

    func showApproval(
        id: String, tool: String, command: String, risk: String, impact: String,
        sourceApp: String?, sourceBundleId: String?, sourceCwd: String?
    ) {
        pendingSourceInfo[id] = (bundleId: sourceBundleId, app: sourceApp)
        postNotification(id: id, tool: tool, command: command, impact: impact, risk: risk)
    }

    private func postNotification(id: String, tool: String, command: String, impact: String, risk: String) {
        let content        = UNMutableNotificationContent()
        let riskEmoji      = risk == "high" ? "🔴" : "🟡"
        let riskLabel      = risk == "high" ? "High Risk" : "Medium Risk"
        let commandPreview = command.count > 120 ? String(command.prefix(120)) + "..." : command
        content.title      = "\(riskEmoji) \(riskLabel) — \(tool)"
        content.body       = "\(impact)\n\(commandPreview)"
        content.subtitle   = "Approval needed — tap to open terminal"
        content.categoryIdentifier = Self.categoryId
        content.userInfo   = ["id": id]
        content.sound      = .default
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()

        let request = UNNotificationRequest(
            identifier: "\(id)-\(Int(Date().timeIntervalSince1970))",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { [weak self] error in
            if let error = error {
                self?.log("Notifications: failed to post — \(error.localizedDescription)")
            }
        }
    }

    // MARK: – Handle tap — activate the source terminal

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let id         = response.notification.request.content.userInfo["id"] as? String ?? ""
        let sourceInfo = pendingSourceInfo.removeValue(forKey: id)

        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()

        // Bring the terminal where Claude Code is running to the foreground
        // so the user lands directly on the native approval dialog.
        activateTerminal(bundleId: sourceInfo?.bundleId, appName: sourceInfo?.app)
        completionHandler()
    }

    // Show notification even when app is in foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // MARK: – Dismiss (called when pending file is deleted)

    func dismissCurrent() {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        pendingSourceInfo = [:]
    }

    // MARK: – Terminal activation

    private func activateTerminal(bundleId: String?, appName: String?) {
        log("activateTerminal — bundleId=\(bundleId ?? "nil")")
        guard let bundleId,
              NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first != nil else {
            log("activateTerminal — source app not found")
            return
        }
        // Use `open -b` to focus the already-running app.
        // This avoids Gatekeeper/Privacy prompts that NSWorkspace.open triggers.
        let task = Process()
        task.launchPath = "/usr/bin/open"
        task.arguments  = ["-b", bundleId]
        do {
            try task.run()
            log("activateTerminal — focused: \(bundleId)")
        } catch {
            log("activateTerminal — open failed: \(error.localizedDescription)")
        }
    }

    // MARK: – Logging

    private func log(_ message: String) {
        let logPath = (notifierDir as NSString).appendingPathComponent("error.log")
        let line    = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        if FileManager.default.fileExists(atPath: logPath),
           let handle = FileHandle(forWritingAtPath: logPath) {
            handle.seekToEndOfFile()
            handle.write(data)
            handle.closeFile()
        } else {
            try? data.write(to: URL(fileURLWithPath: logPath))
        }
    }
}
