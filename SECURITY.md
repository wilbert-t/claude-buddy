# Security & Permissions

## macOS Permissions

Claude Buddy requests **one macOS permission**:

### Notifications
Used to show approval banners when Claude needs your attention.

That's it. No other permissions are requested or required.

---

## What we removed

Older versions used `osascript` to bring your terminal to front, which triggered the **Automation** permission dialog ("ClaudeNotifier wants to control Terminal"). This has been replaced with `open -b <bundleId>` — a standard shell command that focuses an app without any special permission.

The code that does this:
- Node.js: [`scripts/platform.js` → `focusTerminal()`](scripts/platform.js)
- Swift app: [`swift-app/ClaudeNotifier/StatusBarController.swift` → `focusApp()`](swift-app/ClaudeNotifier/StatusBarController.swift)

We never read terminal content, keystrokes, shell history, or file contents.

---

## What data Claude Buddy touches

| Data | Where | Purpose |
|------|-------|---------|
| Tool name + command preview + risk level | `~/.claude-notifier/audit.json` | Approval history log |
| Pending approval metadata (`id`, tool, command preview, risk, impact, source app, source bundle ID, source working directory, timestamp) | `~/.claude-notifier/pending-approval.json` | Passed to menu bar app for banner + "Open Terminal" targeting |
| Approval decision metadata (`id`, decision, source, timestamp) | `~/.claude-notifier/approval-response.json` | Hand-off between notification action and terminal approval flow |
| Character state + recent events | `~/.claude-notifier/state.json`, `~/.claude-notifier/events.jsonl` | Menu bar animation state |
| User settings | `~/.claude-notifier/settings.json` | Notification behavior, quiet hours, auto-approve rules, audit retention |
| Error messages | `~/.claude-notifier/error.log` | Debug info |

**All data is local.** No network requests. No telemetry. No external services.

---

## Verifying the binary

Pre-built releases of `ClaudeNotifier.app` are built via GitHub Actions from this repository. Each release includes a SHA256 checksum you can verify:

```bash
# After downloading ClaudeNotifier.app.zip:
shasum -a 256 ClaudeNotifier.app.zip
# Compare with the SHA256 listed on the release page
```

If you install with `npx claude-alert install --with-companion`, the installer enforces:
- SHA256 check against the release checksum asset
- `codesign --verify --deep --strict`
- `spctl --assess --type execute`

If any check fails, companion installation is aborted.

If you prefer to audit the code yourself, build from source:

```bash
git clone https://github.com/wilbert-t/claude-alert.git
cd claude-alert/swift-app
xcodebuild -project ClaudeNotifier.xcodeproj \
  -scheme ClaudeNotifier -configuration Release -derivedDataPath .build
```

---

## Vulnerability disclosure

Found a security issue? Please open a [GitHub Issue](https://github.com/wilbert-t/claude-alert/issues) with the label `security`. For sensitive issues, contact the maintainer directly via GitHub.

We aim to respond within 48 hours.
