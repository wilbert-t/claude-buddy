#!/usr/bin/env node

/**
 * Claude Code Notifier — PreToolUse Hook
 *
 * Runs before every tool use. Classifies risk:
 *   LOW    → exit 0 immediately (auto-approve, silent)
 *   MED/HIGH → write pending-approval.json, poll for response, exit 0 or 2
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { classifyRisk, analyzeRisk } from './risk.js';
import * as settings from './settings.js';
import CharacterState from './character-state.js';
import { isCompanionRunning, launchCompanion, notify as platformNotify } from './platform.js';

const NOTIFIER_DIR      = path.join(os.homedir(), '.claude-notifier');
const PENDING_FILE      = path.join(NOTIFIER_DIR, 'pending-approval.json');
const RESPONSE_FILE     = path.join(NOTIFIER_DIR, 'approval-response.json');

const characterState = new CharacterState();

function detectSourceApp() {
  if (process.env.TERM_PROGRAM === 'vscode' || process.env.VSCODE_IPC_HOOK_CLI) {
    return { sourceApp: 'Visual Studio Code', sourceBundleId: 'com.microsoft.VSCode' };
  }
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') {
    return { sourceApp: 'Terminal', sourceBundleId: 'com.apple.Terminal' };
  }
  if (process.env.TERM_PROGRAM === 'iTerm.app' || process.env.ITERM_SESSION_ID) {
    return { sourceApp: 'iTerm', sourceBundleId: 'com.googlecode.iterm2' };
  }
  if ((process.env.TERM_PROGRAM || '').toLowerCase().includes('warp')) {
    return { sourceApp: 'Warp', sourceBundleId: 'dev.warp.Warp-Stable' };
  }
  if (process.env.TERM_PROGRAM) {
    return { sourceApp: process.env.TERM_PROGRAM, sourceBundleId: null };
  }
  return { sourceApp: 'Unknown Terminal', sourceBundleId: null };
}

// ── Exported helpers (also used by tests) ─────────────────────────────────────

export function writePendingApproval(id, tool, command, risk, impact, source = {}) {
  try {
    const sourceApp = source.sourceApp || null;
    const sourceBundleId = source.sourceBundleId || null;
    const sourceCwd = source.sourceCwd || null;
    if (!fs.existsSync(NOTIFIER_DIR)) fs.mkdirSync(NOTIFIER_DIR, { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify({
      id,
      tool,
      command: String(command).slice(0, 200),
      risk,
      impact,
      sourceApp,
      sourceBundleId,
      sourceCwd,
      requestedAt: new Date().toISOString()
    }));
  } catch (err) {
    settings.logError(`pre-tool: failed to write pending approval: ${err.message}`);
  }
}

export function readResponse(id) {
  try {
    if (!fs.existsSync(RESPONSE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(RESPONSE_FILE, 'utf-8'));
    if (data.id !== id) return null;
    if (data.decision !== 'approved' && data.decision !== 'rejected') return null;
    return data.decision;
  } catch {
    return null;
  }
}

export function writeResponse(id, decision, source = 'terminal') {
  try {
    if (!fs.existsSync(NOTIFIER_DIR)) fs.mkdirSync(NOTIFIER_DIR, { recursive: true });
    const payload = {
      id,
      decision,
      source,
      respondedAt: new Date().toISOString()
    };
    const tmp = `${RESPONSE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, RESPONSE_FILE);
    return true;
  } catch (err) {
    settings.logError(`pre-tool: failed to write response: ${err.message}`);
    return false;
  }
}

export function cleanup(options = {}) {
  const { removePending = true, removeResponse = true } = options;
  if (removePending) {
    try { fs.rmSync(PENDING_FILE, { force: true }); } catch {}
  }
  if (removeResponse) {
    try { fs.rmSync(RESPONSE_FILE, { force: true }); } catch {}
  }
}



// ── Companion app auto-launch ──────────────────────────────────────────────────

function ensureCompanionApp() {
  if (!isCompanionRunning()) {
    launchCompanion();
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main() {
  ensureCompanionApp();
  try {
    // Read event JSON from stdin (hook pipe — not a TTY)
    const rl = readline.createInterface({
      input: process.stdin,
      output: null,
    });

    let eventLine;
    try {
      eventLine = await new Promise((resolve) => {
        rl.once('line', resolve);
      });
    } catch {
      process.exit(0);
    }

    let event;
    try {
      event = JSON.parse(eventLine);
    } catch {
      rl.close();
      process.exit(0);
    }

    // Claude Code sends tool_name + tool_input (PreToolUse hook format)
    const tool    = event.tool_name || event.tool || 'unknown';
    const command = event.tool_input?.command ?? event.input?.command ?? event.command ?? JSON.stringify(event.tool_input ?? event.input ?? {});

    const appSettings = settings.read();
    const autoApproveLevel    = appSettings.autoApproveLevel ?? 'low';
    const customPatterns      = appSettings.customPatterns ?? {};
    const trustedPaths        = appSettings.autoApproveTrustedPaths ?? [];

    const risk = classifyRisk(tool, command, customPatterns);

    // Auto-approve if cwd is in a trusted path
    const cwd = process.cwd();
    const inTrustedPath = trustedPaths.some(p => {
      const expanded = p.replace(/^~/, os.homedir());
      return cwd === expanded || cwd.startsWith(expanded + path.sep);
    });

    if (inTrustedPath) {
      rl.close();
      process.stdout.write(JSON.stringify({ decision: 'approve' }) + '\n');
      process.exit(0);
    }

    // Auto-approve based on configured threshold
    // "low"    → approve only low risk (default)
    // "medium" → approve low + medium
    // "none"   → never auto-approve
    const autoApproveLevels = {
      none:   [],
      low:    ['low'],
      medium: ['low', 'medium']
    };
    const approveSet = autoApproveLevels[autoApproveLevel] ?? ['low'];

    if (approveSet.includes(risk)) {
      rl.close();
      process.stdout.write(JSON.stringify({ decision: 'approve' }) + '\n');
      process.exit(0);
    }

    // MED/HIGH → write pending-approval.json and exit 0 immediately.
    // Claude Code shows its native dialog (terminal path).
    // The Swift app sends a keystroke to that terminal when the user
    // approves/rejects via notification (remote path).
    const { impact } = analyzeRisk(tool, command);

    const id     = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const source = detectSourceApp();
    source.sourceCwd = process.cwd();

    cleanup();
    writePendingApproval(id, tool, command, risk, impact, source);

    const stateStatus = risk === 'high' ? 'pending_high' : 'pending_medium';
    characterState.writeState(stateStatus, risk, 1, null, new Date().toISOString());

    // Always fire terminal notification — companion app is menu bar UI only
    platformNotify('Claude needs approval', impact);

    rl.close();
    process.exit(0);

  } catch (err) {
    settings.logError(`pre-tool crashed: ${err.message}`);
    process.exit(0); // never block Claude Code on error
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(() => process.exit(0));
}
