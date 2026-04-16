#!/usr/bin/env node

/**
 * Install script for Claude Code Notifier skill
 *
 * Configures the Notification hook in ~/.claude/settings.json
 * Creates ~/.claude-notifier/ directory and default settings.json.
 *
 * Optional: --with-companion (macOS only)
 * Downloads and installs ClaudeNotifier.app from latest GitHub release with:
 *   1) SHA256 verification (required)
 *   2) code signature verification (required)
 *   3) Gatekeeper assessment (required)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as settingsManager from '../scripts/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const SETTINGS_PATH = path.join(CLAUDE_HOME, 'settings.json');
const NOTIFIER_DIR = path.join(os.homedir(), '.claude-notifier');
const NOTIFIER_SETTINGS = path.join(NOTIFIER_DIR, 'settings.json');
const COMPANION_DIR = path.join(NOTIFIER_DIR, 'companion');
const COMPANION_APP_PATH = path.join(COMPANION_DIR, 'ClaudeNotifier.app');

const GITHUB_OWNER = 'wilbert-t';
const GITHUB_REPO = 'claude-alert';
const RELEASES_LATEST_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const COMPANION_ZIP_NAME = 'ClaudeNotifier.app.zip';

// Scripts are copied to a stable location so npx cache clears don't break hooks
const SOURCE_SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const STABLE_SCRIPTS_DIR = path.join(NOTIFIER_DIR, 'scripts');
const NOTIFY_SCRIPT = path.join(STABLE_SCRIPTS_DIR, 'notify.js');
const PRE_TOOL_SCRIPT = path.join(STABLE_SCRIPTS_DIR, 'pre-tool.js');
const POST_TOOL_SCRIPT = path.join(STABLE_SCRIPTS_DIR, 'post-tool.js');

function parseOptions() {
  const known = new Set(['--with-companion']);
  const flags = process.argv.slice(2).filter(arg => arg.startsWith('--'));
  const unknown = flags.filter(flag => !known.has(flag));

  if (unknown.length > 0) {
    throw new Error(`Unknown option(s): ${unknown.join(', ')}`);
  }

  return {
    withCompanion: flags.includes('--with-companion')
  };
}

function hasCommand(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ensureCommand(command, reason) {
  if (!hasCommand(command)) {
    throw new Error(`Required command not found: ${command} (${reason})`);
  }
}

function sha256Hex(filePath) {
  const data = fs.readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

function extractExpectedSha256(checksumText, targetFileName) {
  const lines = String(checksumText || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const targetBase = path.basename(targetFileName);

  for (const line of lines) {
    // sha256sum format: "<hash>  <file>"
    const sumFormat = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (sumFormat) {
      const [, hash, fileName] = sumFormat;
      if (path.basename(fileName.trim()) === targetBase) {
        return hash.toLowerCase();
      }
    }

    // openssl format: "SHA256(file) = <hash>"
    const opensslFormat = line.match(/^SHA256\s*\((.+)\)\s*=\s*([a-fA-F0-9]{64})$/i);
    if (opensslFormat) {
      const [, fileName, hash] = opensslFormat;
      if (path.basename(fileName.trim()) === targetBase) {
        return hash.toLowerCase();
      }
    }
  }

  // Single-line fallback: file contains only the hash
  if (lines.length === 1 && /^[a-fA-F0-9]{64}$/.test(lines[0])) {
    return lines[0].toLowerCase();
  }

  return null;
}

async function fetchJson(url) {
  if (typeof fetch !== 'function') {
    throw new Error('This Node.js runtime does not support fetch(). Please use Node 18+.');
  }

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'claude-alert-installer'
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while requesting ${url}`);
  }

  return res.json();
}

async function downloadFile(url, destinationPath, label) {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/octet-stream',
      'User-Agent': 'claude-alert-installer'
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while downloading ${label}`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destinationPath, bytes);
  return bytes.length;
}

function verifyCompanionApp(appPath) {
  ensureCommand('codesign', 'required for signature verification');
  ensureCommand('spctl', 'required for Gatekeeper assessment');

  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'ignore' });
  } catch (err) {
    throw new Error(`Companion signature verification failed (codesign): ${err.message}`);
  }

  try {
    execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath], { stdio: 'ignore' });
  } catch (err) {
    throw new Error(`Companion Gatekeeper assessment failed (spctl): ${err.message}`);
  }
}

async function installCompanionApp() {
  if (process.platform !== 'darwin') {
    console.warn('⚠️  --with-companion is macOS-only. Skipping companion install.');
    return false;
  }

  ensureCommand('unzip', 'required to extract ClaudeNotifier.app.zip');
  ensureCommand('open', 'required to launch ClaudeNotifier.app');

  console.log('\n🤖 Installing macOS companion app (--with-companion)...');
  console.log('   Fetching latest release metadata...');

  const release = await fetchJson(RELEASES_LATEST_URL);
  const assets = Array.isArray(release.assets) ? release.assets : [];

  const zipAsset = assets.find(asset => asset.name === COMPANION_ZIP_NAME);
  if (!zipAsset?.browser_download_url) {
    throw new Error(`Latest release does not include ${COMPANION_ZIP_NAME}`);
  }

  const checksumAsset = assets.find(
    asset => /sha256|checksums?/i.test(asset.name) && asset.browser_download_url
  );
  if (!checksumAsset) {
    throw new Error(
      'Latest release is missing a checksum asset (expected name containing "sha256" or "checksums"). Refusing install.'
    );
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alert-companion-'));
  const zipPath = path.join(tempDir, zipAsset.name);
  const checksumPath = path.join(tempDir, checksumAsset.name);

  try {
    console.log(`   Downloading ${zipAsset.name}...`);
    await downloadFile(zipAsset.browser_download_url, zipPath, zipAsset.name);
    console.log(`✓ Downloaded ${zipAsset.name}`);

    console.log(`   Downloading ${checksumAsset.name}...`);
    await downloadFile(checksumAsset.browser_download_url, checksumPath, checksumAsset.name);
    console.log(`✓ Downloaded ${checksumAsset.name}`);

    const checksumText = fs.readFileSync(checksumPath, 'utf-8');
    const expectedHash = extractExpectedSha256(checksumText, zipAsset.name);
    if (!expectedHash) {
      throw new Error(`Could not find SHA256 entry for ${zipAsset.name} in ${checksumAsset.name}`);
    }

    const actualHash = sha256Hex(zipPath);
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error(
        `SHA256 mismatch for ${zipAsset.name}. Expected ${expectedHash}, got ${actualHash}`
      );
    }
    console.log('✓ SHA256 checksum verified');

    fs.mkdirSync(COMPANION_DIR, { recursive: true });
    fs.rmSync(COMPANION_APP_PATH, { recursive: true, force: true });
    execFileSync('unzip', ['-o', zipPath, '-d', COMPANION_DIR], { stdio: 'ignore' });

    if (!fs.existsSync(COMPANION_APP_PATH)) {
      throw new Error('Archive extracted but ClaudeNotifier.app was not found');
    }

    verifyCompanionApp(COMPANION_APP_PATH);
    console.log('✓ Companion signature + Gatekeeper checks passed');

    execFileSync('open', [COMPANION_APP_PATH], { stdio: 'ignore' });
    console.log(`✓ Companion app installed and launched from ${COMPANION_APP_PATH}`);
    return true;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only
    }
  }
}

/**
 * Ensure Claude Code settings directory exists
 */
function ensureClaudeDir() {
  if (!fs.existsSync(CLAUDE_HOME)) {
    fs.mkdirSync(CLAUDE_HOME, { recursive: true });
    console.log(`✓ Created ${CLAUDE_HOME}`);
  }
}

/**
 * Read Claude Code settings.json
 */
function readClaudeSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return { hooks: {} };
  }
  const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
  return JSON.parse(content); // Let parse errors propagate — don't silently overwrite settings
}

/**
 * Write Claude Code settings.json
 */
function writeClaudeSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log(`✓ Updated ${SETTINGS_PATH}`);
  } catch (err) {
    console.error(`✗ Failed to write settings: ${err.message}`);
    throw err;
  }
}

/**
 * Add Notification hook to settings
 */
function addNotificationHook(settings) {
  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Check if Notification hook already exists
  if (!settings.hooks.Notification) {
    settings.hooks.Notification = [];
  }

  // Check if our hook is already registered (support both old and new format)
  const hookExists = settings.hooks.Notification.some(
    hook =>
      (hook.run && hook.run.includes('notify.js')) ||
      (hook.hooks && hook.hooks.some(h => h.command && h.command.includes('notify.js')))
  );

  if (!hookExists) {
    settings.hooks.Notification.push({
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: `node ${NOTIFY_SCRIPT}`
        }
      ]
    });
    return true; // Hook was added
  }

  return false; // Hook already existed
}

/**
 * Add PreToolUse hook to settings
 */
function addPreToolUseHook(settings) {
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  const hookExists = settings.hooks.PreToolUse.some(
    hook => hook.hooks?.some(h => h.command?.includes('pre-tool.js'))
  );

  if (!hookExists) {
    settings.hooks.PreToolUse.push({
      matcher: '',
      hooks: [{ type: 'command', command: `node ${PRE_TOOL_SCRIPT}` }]
    });
    return true;
  }
  return false;
}

/**
 * Add PostToolUse hook to settings
 */
function addPostToolUseHook(settings) {
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

  const hookExists = settings.hooks.PostToolUse.some(
    hook => hook.hooks?.some(h => h.command?.includes('post-tool.js'))
  );

  if (!hookExists) {
    settings.hooks.PostToolUse.push({
      matcher: '',
      hooks: [{ type: 'command', command: `node ${POST_TOOL_SCRIPT}` }]
    });
    return true;
  }
  return false;
}

/**
 * Create notifier directory and settings
 */
function initializeNotifierDir() {
  try {
    if (!fs.existsSync(NOTIFIER_DIR)) {
      fs.mkdirSync(NOTIFIER_DIR, { recursive: true });
      console.log(`✓ Created ${NOTIFIER_DIR}`);
    }

    // Write notifier settings if not present
    if (!fs.existsSync(NOTIFIER_SETTINGS)) {
      fs.writeFileSync(NOTIFIER_SETTINGS, JSON.stringify(settingsManager.defaults(), null, 2));
      console.log(`✓ Created default notifier settings at ${NOTIFIER_SETTINGS}`);
    } else {
      console.log(`✓ Notifier settings already exist at ${NOTIFIER_SETTINGS}`);
    }
  } catch (err) {
    console.error(`✗ Failed to initialize notifier directory: ${err.message}`);
    throw err;
  }
}

/**
 * Copy scripts to stable location (~/.claude-notifier/scripts/)
 * so hooks keep working even if the npx cache is cleared.
 */
function copyScripts() {
  try {
    fs.mkdirSync(STABLE_SCRIPTS_DIR, { recursive: true });
    const files = fs.readdirSync(SOURCE_SCRIPTS_DIR).filter(f => f.endsWith('.js'));
    for (const file of files) {
      fs.copyFileSync(
        path.join(SOURCE_SCRIPTS_DIR, file),
        path.join(STABLE_SCRIPTS_DIR, file)
      );
    }
    console.log(`✓ Copied scripts to ${STABLE_SCRIPTS_DIR}`);
  } catch (err) {
    console.error(`✗ Failed to copy scripts: ${err.message}`);
    throw err;
  }
}

/**
 * Verify system sounds are available (platform-aware)
 */
function verifySounds() {
  if (process.platform === 'darwin') {
    const sounds = [
      '/System/Library/Sounds/Glass.aiff',
      '/System/Library/Sounds/Ping.aiff',
      '/System/Library/Sounds/Sosumi.aiff'
    ];
    const missing = sounds.filter(s => !fs.existsSync(s));
    if (missing.length > 0) {
      console.warn(`⚠️  Some system sounds not found: ${missing.join(', ')}`);
      console.warn('   Customize soundPaths in ~/.claude-notifier/settings.json');
    } else {
      console.log('✓ System sounds verified');
    }
  } else if (process.platform === 'win32') {
    console.log('✓ Using Windows SystemSounds (Asterisk / Exclamation / Hand)');
  } else {
    // Linux — check for notify-send and paplay
    try {
      execFileSync('which', ['notify-send'], { stdio: 'ignore' });
      console.log('✓ notify-send available');
    } catch {
      console.warn('⚠️  notify-send not found. Install with: sudo apt install libnotify-bin');
    }
    try {
      execFileSync('which', ['paplay'], { stdio: 'ignore' });
      console.log('✓ paplay available');
    } catch {
      console.warn('⚠️  paplay not found. Install with: sudo apt install pulseaudio-utils');
    }
  }
}

/**
 * Main install function
 */
async function install() {
  const options = parseOptions();
  console.log('\n🔔 Claude Code Notifier — Installation\n');

  // Plugin mode: hooks are already registered by hooks/hooks.json.
  // Just create ~/.claude-notifier/ and settings — skip script copying and settings.json edits.
  const isPluginMode = !!process.env.CLAUDE_PLUGIN_ROOT;

  try {
    // Step 1: Initialize notifier directory (always needed)
    console.log('📁 Setting up directories...');
    initializeNotifierDir();

    if (isPluginMode) {
      console.log('ℹ️  Running as Claude Code plugin — hooks registered via hooks.json, skipping manual hook registration.');
    } else {
      // Step 2: Ensure Claude directory exists (npm mode only)
      ensureClaudeDir();

      // Step 3: Copy scripts to stable location
      console.log('\n📋 Installing scripts...');
      copyScripts();

      // Step 4: Read Claude settings and add hooks
      console.log('\n🔧 Configuring Claude Code hooks...');
      const claudeSettings = readClaudeSettings();
      const hookAdded = addNotificationHook(claudeSettings);
      addPreToolUseHook(claudeSettings);
      addPostToolUseHook(claudeSettings);
      writeClaudeSettings(claudeSettings);

      if (!hookAdded) {
        console.log('ℹ️  Notification hook was already configured.');
      }
    }

    // Step 5: Verify sounds (always)
    console.log('\n🔊 Verifying alert sounds...');
    verifySounds();

    // Step 6: Optional companion install (explicit opt-in)
    let companionInstalled = false;
    if (options.withCompanion) {
      companionInstalled = await installCompanionApp();
    }

    // Success!
    console.log('\n✅ Installation complete!\n');
    console.log('📋 Next steps:');
    console.log('  1. Review settings: nano ~/.claude-notifier/settings.json');
    const soundTest = process.platform === 'darwin'
      ? 'afplay /System/Library/Sounds/Glass.aiff'
      : process.platform === 'win32'
        ? 'powershell -Command "[System.Media.SystemSounds]::Asterisk.Play()"'
        : 'paplay /usr/share/sounds/freedesktop/stereo/message.oga';
    console.log(`  2. Test a sound: ${soundTest}`);
    if (process.platform === 'darwin') {
      if (companionInstalled) {
        console.log('  3. Companion app is installed and running.');
      } else {
        console.log('  3. (Optional) One-line companion install with verification:');
        console.log('     npx claude-alert install --with-companion');
      }
    }
    console.log('  4. To uninstall: npx claude-alert uninstall\n');

  } catch (err) {
    console.error('\n❌ Installation failed:', err.message, '\n');
    process.exit(1);
  }
}

// Run install
install().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
