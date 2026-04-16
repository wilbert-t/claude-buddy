#!/usr/bin/env node

/**
 * CLI entry point for `npx claude-alert`
 * Routes install / uninstall commands to the setup scripts.
 */

import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2];

if (cmd === 'install') {
  await import(path.join(__dirname, 'setup', 'install.js'));
} else if (cmd === 'config') {
  await import(path.join(__dirname, 'setup', 'config.js'));
} else if (cmd === 'uninstall') {
  await import(path.join(__dirname, 'setup', 'uninstall.js'));
} else {
  console.log(`
Claude Alert — Claude Code notification system
https://github.com/wilbert-t/claude-alert

Usage:
  npx claude-alert install [--with-companion]
                              Install hooks and configure
                              --with-companion (macOS): download + verify + install menu bar app
  npx claude-alert config     Show current settings
  npx claude-alert config --set key=value
                              Update a setting
  npx claude-alert config --open
                              Open settings file in your editor/app
  npx claude-alert uninstall  Remove hooks and clean up

Platform support:
  macOS   — Native banner notifications + menu bar app (optional)
  Linux   — notify-send notifications + sound via paplay/aplay
  Windows — PowerShell balloon tips + SystemSounds
`);
  process.exit(0);
}
