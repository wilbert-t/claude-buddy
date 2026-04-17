#!/usr/bin/env node

/**
 * Platform abstraction layer.
 * All platform-specific subprocess calls live here.
 * Every function is silent on failure — try/catch, log error, never throw.
 *
 * Each exported function accepts an optional _platform parameter
 * (defaults to process.platform) for testability across all platforms.
 */

import { execSync, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ERROR_LOG = path.join(os.homedir(), '.claude-notifier', 'error.log');

function logError(msg) {
  try {
    fs.mkdirSync(path.dirname(ERROR_LOG), { recursive: true });
    fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// ── notify ────────────────────────────────────────────────────────────────────

/**
 * Fire a native system notification.
 * macOS: osascript display notification
 * Windows: PowerShell balloon tip (detached, non-blocking)
 * Linux: notify-send with wall fallback
 *
 * @param {string} title
 * @param {string} body
 * @param {string} [_platform] - override for testing
 */
export function notify(title, body, _platform = process.platform) {
  const safeTitle = String(title || '').replace(/['"\\]/g, ' ').slice(0, 100);
  const safeBody  = String(body  || '').replace(/['"\\]/g, ' ').slice(0, 200);

  try {
    if (_platform === 'darwin') {
      const tnBin = path.join(os.homedir(), '.claude-notifier', 'bin', 'terminal-notifier.app', 'Contents', 'MacOS', 'terminal-notifier');
      if (fs.existsSync(tnBin)) {
        execFileSync(tnBin, ['-title', safeTitle, '-message', safeBody, '-sound', 'default'], { stdio: 'ignore', timeout: 5000 });
      } else {
        execFileSync(
          'osascript',
          ['-e', `display notification "${safeBody}" with title "${safeTitle}"`],
          { stdio: 'ignore', timeout: 5000 }
        );
      }
    } else if (_platform === 'win32') {
      // Detached PowerShell balloon tip — non-blocking
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$n = New-Object System.Windows.Forms.NotifyIcon;',
        '$n.Icon = [System.Drawing.SystemIcons]::Information;',
        '$n.Visible = $true;',
        `$n.ShowBalloonTip(4000, '${safeTitle}', '${safeBody}', 'Info');`,
        'Start-Sleep -Milliseconds 4500;',
        '$n.Dispose()'
      ].join(' ');
      try {
        const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
          stdio: 'ignore',
          detached: true
        });
        child.on('error', () => {}); // Silently ignore spawn errors
        child.unref();
      } catch {}
      // Ignore errors — PowerShell may not exist on non-Windows
    } else {
      // Linux — notify-send
      execFileSync('notify-send', [safeTitle, safeBody], { stdio: 'ignore', timeout: 5000 });
    }
  } catch (err) {
    // Fallback
    try {
      if (_platform === 'linux') {
        execFileSync('wall', [`${safeTitle}: ${safeBody}`], { stdio: 'ignore', timeout: 3000 });
      }
    } catch {}
    logError(`platform.notify failed (${_platform}): ${err.message}`);
  }
}

// ── focusTerminal ─────────────────────────────────────────────────────────────

/**
 * Bring the user's terminal window to front.
 * macOS only — no-op on Windows/Linux (no reliable cross-platform equivalent).
 *
 * @param {string} bundleId   - macOS app bundle ID, e.g. 'com.apple.Terminal'
 * @param {string} [_platform]
 */
export function focusTerminal(bundleId, _platform = process.platform) {
  if (_platform !== 'darwin' || !bundleId) return;
  try {
    execFileSync('open', ['-b', bundleId], { stdio: 'ignore', timeout: 3000 });
  } catch (err) {
    logError(`platform.focusTerminal failed: ${err.message}`);
  }
}

// ── isCompanionRunning ────────────────────────────────────────────────────────

/**
 * Check if the ClaudeNotifier.app menu bar process is running.
 * macOS only — always false on other platforms (no companion app).
 *
 * @param {string} [_platform]
 * @returns {boolean}
 */
export function isCompanionRunning(_platform = process.platform) {
  if (_platform !== 'darwin') return false;
  try {
    execSync('pgrep -x ClaudeNotifier', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── launchCompanion ───────────────────────────────────────────────────────────

/**
 * Launch ClaudeNotifier.app. Caller is responsible for checking isCompanionRunning() first.
 * macOS only — no-op on other platforms.
 *
 * @param {string} [_platform]
 */
export function launchCompanion(_platform = process.platform) {
  if (_platform !== 'darwin') return;
  try {
    execSync('open -a ClaudeNotifier', { stdio: 'ignore' });
  } catch (err) {
    logError(`platform.launchCompanion failed: ${err.message}`);
  }
}
