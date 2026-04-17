# Claude Alert

Never miss a Claude Code approval prompt.

![Claude Alert in action](docs/assets/hero.png)

---

## Install

### Via GitHub (Recommended)

Clone the repo and run the install script directly — no build step, no external dependencies required.

```bash
git clone https://github.com/wilbert-t/claude-buddy.git
cd claude-buddy
node setup/install.js
```

This registers all hooks, copies scripts to `~/.claude-notifier/scripts/`, and compiles the Swift notification helper on macOS.

> **macOS requirement:** Xcode Command Line Tools must be installed for the notification helper to compile. If not installed: `xcode-select --install`

**Uninstall:**

```bash
node setup/uninstall.js
```

---

### Via Plugin

```
/plugin install claude-alert@claude-plugins-official
```

Hooks register automatically. Done.

### Via npm

```bash
npx claude-alert install
```

> Note: The npm path is available but the GitHub install above is recommended for now while code signing and notarization are being finalized.

---

## The Problem

Claude Code works autonomously — until it needs your approval.
Then it pauses. Silently. And waits.

If you're in another window, on your phone, or just not watching —
Claude sits idle. You lose time. The flow breaks.

**Claude Alert fixes this.** The moment Claude needs you, you know about it.
Native banner. Your terminal focused and ready.

---

## How It Works

![Claude Alert icon](docs/assets/icon.gif)

| Risk | Examples | What Happens |
|------|----------|--------------|
| 🟢 Low | Glob, Grep, Read, LS | Auto-approved silently — no interruption |
| 🟡 Medium | Write, Edit, npm install, mv | Banner notification |
| 🔴 High | rm -rf, git push --force, sudo, DROP TABLE, curl\|bash | Banner notification |

Low-risk operations are approved silently so Claude never pauses for safe work.
Medium and high-risk operations fire a native banner and wait for your input.

---

## Configuration

Quick settings commands:

```bash
# View current settings
npx claude-alert config

# Update a setting
npx claude-alert config --set notificationsEnabled=false
npx claude-alert config --set autoApproveLevel=medium

# Open settings in your editor/app
npx claude-alert config --open
```

Advanced fallback: edit `~/.claude-notifier/settings.json` directly. All fields are optional — defaults work out of the box.

```json
{
  "quietHoursStart": "22:00",
  "quietHoursEnd": "08:00",
  "quietDays": ["Saturday", "Sunday"],
  "autoApproveLevel": "low"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `quietHoursStart` | `null` | Start of mute window (24h format) |
| `quietHoursEnd` | `null` | End of mute window |
| `quietDays` | `[]` | Days to mute all notifications |
| `autoApproveLevel` | `"low"` | Auto-approve threshold: `"none"`, `"low"`, or `"medium"` |

### Notification Style

For approval prompts, switch ClaudeNotifier to **Alert** style so the banner stays on screen until you act:

**System Settings → Notifications → ClaudeNotifier → Alerts**

---

## Audit Log

Every approval event is logged to `~/.claude-notifier/audit.json`.

```bash
# Last 10 approvals
jq '.[-10:]' ~/.claude-notifier/audit.json

# High-risk only
jq '[.[] | select(.riskLevel == "high")]' ~/.claude-notifier/audit.json

# Count by risk level
jq 'group_by(.riskLevel) | map({risk: .[0].riskLevel, count: length})' ~/.claude-notifier/audit.json
```

---

## Troubleshooting

**No notification appears**
- Check logs: `tail -20 ~/.claude-notifier/error.log`
- Verify notification permission: System Settings → Notifications → ClaudeNotifier

**Hooks not firing**
- Check: `cat ~/.claude/settings.json | grep claude-alert`

**Menu bar app not showing**
- Check: `pgrep -fl ClaudeNotifier`
- Notification daemon broken? Log out and log back in. Never run `killall usernoted`.

---

## Uninstall

```bash
node setup/uninstall.js
```

Use `--clean-all` to also remove audit logs and settings.

Or if installed via npm:

```bash
npx claude-alert uninstall
```

---

## Privacy

All data stays local in `~/.claude-notifier/`. Claude Alert stores audit entries, pending approval metadata (including source app, source bundle ID, and source working directory), user settings, and local error logs. No network requests. No telemetry. You own your audit log.

---

## License

MIT
