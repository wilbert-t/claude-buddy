/**
 * Risk classifier for Claude Code tools
 *
 * Categorizes tools and commands as low/medium/high risk
 * based on their destructive potential.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// Each rule: pattern to match + human-friendly impact sentence
const HIGH_RISK_RULES = [
  { pattern: /\bsudo\b/,                              impact: 'Running with root privileges' },
  { pattern: /\brm\b.*-[rf]/,                         impact: 'Deleting files recursively' },
  { pattern: /\brm\s*-/,                              impact: 'Deleting files' },
  { pattern: /rmdir/,                                  impact: 'Removing a directory' },
  { pattern: /\bdrop\s+(?:table|database|schema|index|view)\b/i,  impact: 'Destroys a database table and all its data' },
  { pattern: /\bdelete\b.*\bfrom\b/i,                 impact: 'Deletes rows from a database table' },
  { pattern: /\btruncate\s+table\s+\w/i,                         impact: 'Empties a database table — cannot be undone' },
  { pattern: /\bflush\s+(?:tables?|privileges?|logs?|status|hosts)\b/i, impact: 'Flushes database state' },
  { pattern: /\bgit\s*reset\b.*--hard/i,              impact: 'Discarding all uncommitted changes' },
  { pattern: /\bgit\s*push\s*--force/i,               impact: 'Force pushing to remote' },
  { pattern: /\bgit\s*clean\b.*-[fd]/i,               impact: 'Deleting all untracked files' },
  { pattern: /\bnpm\s*uninstall\b/i,                  impact: 'Removing an npm package' },
  { pattern: /\bpip\s*uninstall\b/i,                  impact: 'Removing a Python package' },
  { pattern: /\bkill\s*-9/,                           impact: 'Force-killing a process' },
  { pattern: /\bpkill/,                               impact: 'Killing processes by name' },
  { pattern: /\bshutdown\b/i,                         impact: 'Shutting down the system' },
  { pattern: /\breboot\b/i,                           impact: 'Rebooting the system' },
  { pattern: /\bcurl\b[^|]*\|\s*(bash|sh)\b/i,        impact: 'Downloading and executing a remote script ⚠️' },
  { pattern: /\bwget\b[^|]*\|\s*sh\b/i,               impact: 'Downloading and executing a remote script ⚠️' },
  { pattern: /\bdd\s+if=/i,                           impact: 'Writing directly to disk — can corrupt filesystem ⚠️' },
  { pattern: /\bmkfs\b/i,                             impact: 'Formatting a disk — destroys all data ⚠️' },
  { pattern: /\bfdisk\b/i,                            impact: 'Editing disk partition table ⚠️' },
  { pattern: /\bchmod\s+(777|666)\b/,                 impact: 'Giving everyone full access — security risk' },
  { pattern: /--force(?:\s|$)/,                        impact: 'Forcing the operation, skipping safety checks' },
  { pattern: /--delete(?:\s|$)/,                       impact: 'Deleting data as part of this operation' },
  { pattern: /--no-prompt(?:\s|$)/,                    impact: 'Skipping all confirmation prompts' },
  { pattern: /--unsafe(?:\s|$)/,                       impact: 'Running in unsafe mode' },
];

const MEDIUM_RISK_RULES = [
  { pattern: /\bcp\b/,                    impact: 'Copying files' },
  { pattern: /\bmv\b/,                    impact: 'Moving or renaming files' },
  { pattern: /\b(create|mkdir|touch)\b/,  impact: 'Creating files or directories' },
  { pattern: /\bnpm\s*install\b/i,        impact: 'Installing an npm package' },
  { pattern: /\bpip\s*install\b/i,        impact: 'Installing a Python package' },
  { pattern: /\byarn\s*add\b/i,           impact: 'Adding a package' },
  { pattern: /\bpush\b/i,                impact: 'Pushing commits to remote' },
  { pattern: /\bcommit\b/i,              impact: 'Creating a commit' },
  { pattern: /\bchmod\b/,               impact: 'Changing file permissions' },
  { pattern: /\bchown\b/,               impact: 'Changing file ownership' },
  { pattern: /\b(grant|revoke)\b/i,      impact: 'Modifying database permissions' },
];

// Computed pattern-only arrays for classifyRisk() — keeps that function unchanged
const HIGH_RISK_PATTERNS  = HIGH_RISK_RULES.map(r => r.pattern);
const MEDIUM_RISK_PATTERNS = MEDIUM_RISK_RULES.map(r => r.pattern);

// Tool names that are inherently risky
const HIGH_RISK_TOOLS = [
  'Bash',      // Arbitrary shell commands
];

const MEDIUM_RISK_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
];

// Explicit impact strings for MEDIUM_RISK_TOOLS (by tool name)
const MEDIUM_RISK_TOOL_IMPACTS = {
  Write:       'Creates or overwrites a file on disk',
  Edit:        'Modifies an existing file on disk',
  MultiEdit:   'Modifies an existing file on disk',
  NotebookEdit:'Modifies a Jupyter notebook on disk',
};

const LOW_RISK_TOOLS = [
  'Glob',
  'Grep',
  'Read',
  'WebFetch',
  'WebSearch',
];

/**
 * Check command against user-defined custom patterns.
 * Returns "high", "medium", "low", or null if no match.
 * @param {string} commandStr - Lowercased command string
 * @param {object} customPatterns - { high: string[], medium: string[], low: string[] }
 * @returns {string|null}
 */
function applyCustomPatterns(commandStr, customPatterns) {
  if (!customPatterns || typeof customPatterns !== 'object') return null;
  for (const level of ['high', 'medium', 'low']) {
    const patterns = customPatterns[level];
    if (!Array.isArray(patterns)) continue;
    for (const pat of patterns) {
      try {
        if (new RegExp(pat, 'i').test(commandStr)) return level;
      } catch {
        // Invalid regex — skip silently
      }
    }
  }
  return null;
}

/**
 * Classify risk level based on tool and command
 * @param {string} tool - Tool name (e.g., "Bash", "Write", "Glob")
 * @param {string} command - Command/input string
 * @param {object} [customPatterns] - Optional user-defined patterns { high, medium, low }
 * @returns {string} "low", "medium", or "high"
 */
export function classifyRisk(tool, command, customPatterns) {
  const commandStr = String(command || '').toLowerCase();

  // User custom patterns take priority over built-in patterns
  const custom = applyCustomPatterns(commandStr, customPatterns);
  if (custom) return custom;

  // Check for high-risk patterns
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(commandStr)) {
      return 'high';
    }
  }

  // Check if tool itself is high-risk
  if (HIGH_RISK_TOOLS.includes(tool)) {
    // But only if it's not a known safe command
    if (!commandStr.match(/\b(ls|pwd|echo|cat|grep|find|which)\b/)) {
      return 'medium'; // Bash is medium by default unless pattern matches
    }
  }

  // Check for medium-risk patterns
  for (const pattern of MEDIUM_RISK_PATTERNS) {
    if (pattern.test(commandStr)) {
      return 'medium';
    }
  }

  // Check if tool itself is medium-risk
  if (MEDIUM_RISK_TOOLS.includes(tool)) {
    return 'medium';
  }

  // Check if tool is known low-risk
  if (LOW_RISK_TOOLS.includes(tool)) {
    return 'low';
  }

  // Default: unknown tools → medium (safer assumption)
  return 'medium';
}

/**
 * Count files/entries in a path (one level deep, bounded).
 * Returns null if path doesn't exist or can't be read.
 */
function countFiles(targetPath) {
  try {
    const resolved = targetPath.replace(/^~/, os.homedir());
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return fs.readdirSync(resolved).length;
    }
    return 1;
  } catch {
    return null;
  }
}

/**
 * Argument-aware inspection: returns a short action-phrase impact string
 * based on the actual arguments in the command, or null if no specific match.
 * Format: present participle, human-readable (e.g. "Deleting 3 files in /tmp")
 */
function inspectCommand(command) {
  const cmd = String(command || '');

  // ── sudo ──────────────────────────────────────────────────────────────────
  const sudoMatch = cmd.match(/\bsudo\s+(.+)/);
  if (sudoMatch) {
    return `Running with root privileges: ${sudoMatch[1].slice(0, 60)}`;
  }

  // ── curl | bash / wget | sh ────────────────────────────────────────────────
  if (/\bcurl\b[^|]*\|\s*(bash|sh)\b/i.test(cmd) || /\bwget\b[^|]*\|\s*sh\b/i.test(cmd)) {
    return 'Downloading and executing a remote script ⚠️';
  }

  // ── dd if= ────────────────────────────────────────────────────────────────
  if (/\bdd\s+if=/i.test(cmd)) {
    return 'Writing directly to disk — can corrupt filesystem ⚠️';
  }

  // ── mkfs / fdisk ──────────────────────────────────────────────────────────
  if (/\bmkfs\b/i.test(cmd)) return 'Formatting a disk — destroys all data ⚠️';
  if (/\bfdisk\b/i.test(cmd)) return 'Editing disk partition table ⚠️';

  // ── rm -rf variants ────────────────────────────────────────────────────────
  const rmRfMatch = cmd.match(/\brm\b[^|&;\n]*-[rf]{1,2}\s+([^\s|&;]+)/);
  if (rmRfMatch) {
    const target = rmRfMatch[1];
    if (target === '/' || target === '/*') return 'Deleting entire filesystem ⚠️';
    if (target === '~' || target === '$HOME' || target === '~/') return 'Deleting your entire home directory ⚠️';
    if (target === '.' || target === './' || target === './.') return 'Deleting current directory contents';
    const count = countFiles(target);
    if (count !== null) return `Deleting ${count} file${count !== 1 ? 's' : ''} in ${target}`;
    return `Deleting ${target}`;
  }

  // ── git push --force ───────────────────────────────────────────────────────
  if (/\bgit\s+push\b.*--force/i.test(cmd)) {
    const stripped = cmd.replace(/--force(?:-with-lease)?/gi, '');
    const m = stripped.match(/git\s+push\s+(\S+)\s+(\S+)/i);
    return m ? `Force pushing to ${m[1]}/${m[2]}` : 'Force pushing to remote';
  }

  // ── git reset --hard ───────────────────────────────────────────────────────
  const gitResetN = cmd.match(/\bgit\s+reset\b.*--hard\s+HEAD~(\d+)/i);
  if (gitResetN) {
    const n = parseInt(gitResetN[1], 10);
    return `Discarding last ${n} commit${n !== 1 ? 's' : ''}`;
  }
  if (/\bgit\s+reset\b.*--hard/i.test(cmd)) return 'Discarding all uncommitted changes';

  // ── git clean ─────────────────────────────────────────────────────────────
  if (/\bgit\s+clean\b.*-[fd]/i.test(cmd)) return 'Deleting all untracked files';

  // ── chmod ─────────────────────────────────────────────────────────────────
  const chmodMatch = cmd.match(/\bchmod\s+(\d+)\s+(\S+)/);
  if (chmodMatch) {
    const [, mode, target] = chmodMatch;
    if (mode === '777' || mode === '666') return `Giving everyone full access to ${target}`;
    if (mode === '600') return `Restricting ${target} to owner only`;
    if (mode === '755') return `Making ${target} executable by everyone`;
    if (mode === '644') return `Making ${target} readable by everyone`;
    return `Changing permissions on ${target} to ${mode}`;
  }

  // ── npm install / uninstall ───────────────────────────────────────────────
  const npmInstallM = cmd.match(/\bnpm\s+install\s+(\S+)/i);
  if (npmInstallM) return `Installing ${npmInstallM[1]}`;
  const npmUninstallM = cmd.match(/\bnpm\s+uninstall\s+(\S+)/i);
  if (npmUninstallM) return `Removing ${npmUninstallM[1]}`;

  // ── pip install ───────────────────────────────────────────────────────────
  const pipInstallM = cmd.match(/\bpip\s+install\s+(\S+)/i);
  if (pipInstallM) return `Installing ${pipInstallM[1]} (Python)`;

  // ── mv / cp / mkdir ───────────────────────────────────────────────────────
  const mvMatch = cmd.match(/\bmv\s+(\S+)\s+(\S+)/);
  if (mvMatch) return `Moving ${mvMatch[1]} → ${mvMatch[2]}`;
  const cpMatch = cmd.match(/\bcp\b[^|&;\n]*\s+(\S+)\s+(\S+)$/);
  if (cpMatch) return `Copying ${cpMatch[1]} → ${cpMatch[2]}`;
  const mkdirMatch = cmd.match(/\bmkdir\s+(?:-p\s+)?(\S+)/);
  if (mkdirMatch) return `Creating directory ${mkdirMatch[1]}`;

  return null; // no specific match — fall through to pattern rules
}

/**
 * Returns risk level, reason, and human-friendly impact for display in notifications.
 *
 * Note: intentionally stricter than classifyRisk() — HIGH_RISK_TOOLS (e.g. Bash)
 * always return 'high' here regardless of command content, because the tool can
 * execute arbitrary code. classifyRisk() has a safe-command carve-out for the
 * Notification hook; analyzeRisk() does not.
 *
 * @param {string} tool
 * @param {string} command
 * @returns {{level: string, reason: string, impact: string}}
 */
export function analyzeRisk(tool, command) {
  const commandStr = String(command || '');
  const lower = commandStr.toLowerCase();

  // Write / Edit tools — extract file path from plain string or JSON tool_input
  if (tool === 'Write' || tool === 'MultiEdit') {
    let filePath = commandStr;
    try { const p = JSON.parse(commandStr); filePath = p.file_path || p.path || filePath; } catch {}
    return { level: 'medium', reason: `Tool '${tool}' creates or modifies a file`, impact: `Writing to ${filePath}` };
  }
  if (tool === 'Edit') {
    let filePath = commandStr;
    try { const p = JSON.parse(commandStr); filePath = p.file_path || p.path || filePath; } catch {}
    return { level: 'medium', reason: `Tool '${tool}' modifies an existing file`, impact: `Editing ${filePath}` };
  }
  if (tool === 'NotebookEdit') {
    let filePath = commandStr;
    try { const p = JSON.parse(commandStr); filePath = p.file_path || p.path || filePath; } catch {}
    return { level: 'medium', reason: `Tool '${tool}' modifies a Jupyter notebook`, impact: `Editing notebook ${filePath}` };
  }

  // Argument-aware inspection takes priority — most specific description wins
  const specific = inspectCommand(commandStr);

  for (const { pattern, impact } of HIGH_RISK_RULES) {
    if (pattern.test(lower)) {
      return { level: 'high', reason: 'Destructive pattern detected', impact: specific ?? impact };
    }
  }

  if (HIGH_RISK_TOOLS.includes(tool)) {
    const preview = commandStr.slice(0, 60);
    return {
      level: 'high',
      reason: `Tool '${tool}' can execute arbitrary commands`,
      impact: specific ?? `Running: ${preview}`
    };
  }

  for (const { pattern, impact } of MEDIUM_RISK_RULES) {
    if (pattern.test(lower)) {
      return { level: 'medium', reason: `Modification detected: ${tool}`, impact: specific ?? impact };
    }
  }

  if (MEDIUM_RISK_TOOLS.includes(tool)) {
    return {
      level: 'medium',
      reason: `Tool '${tool}' modifies files or system state`,
      impact: specific ?? 'Modifying files or system state'
    };
  }

  if (LOW_RISK_TOOLS.includes(tool)) {
    return { level: 'low', reason: `Tool '${tool}' is read-only`, impact: 'Read-only operation — no changes made' };
  }

  return {
    level: 'medium',
    reason: `Tool '${tool}' — safety classification uncertain`,
    impact: specific ?? `Running: ${commandStr.slice(0, 60)}`
  };
}
