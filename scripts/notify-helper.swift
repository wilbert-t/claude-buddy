import Foundation
import UserNotifications

let title = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Claude Alert"
let body  = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""

let center = UNUserNotificationCenter.current()
let sema = DispatchSemaphore(value: 0)

center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
    guard granted else { sema.signal(); return }

    let content = UNMutableNotificationContent()
    content.title = title
    content.body  = body
    content.sound = .default

    let request = UNNotificationRequest(
        identifier: UUID().uuidString,
        content: content,
        trigger: nil
    )
    center.add(request) { _ in sema.signal() }
}

sema.wait()
Thread.sleep(forTimeInterval: 1.0)
