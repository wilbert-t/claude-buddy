#!/usr/bin/env node

/**
 * Config management for Claude Alert.
 *
 * Commands:
 *   npx claude-alert config
 *   npx claude-alert config --set key=value
 *   npx claude-alert config --open
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import * as settingsManager from '../scripts/settings.js';

const NOTIFIER_DIR = path.join(os.homedir(), '.claude-notifier');
const SETTINGS_PATH = path.join(NOTIFIER_DIR, 'settings.json');

function getArgs() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'config') {
    return argv.slice(1);
  }
  return argv;
}

function ensureSettingsFile() {
  if (!fs.existsSync(NOTIFIER_DIR)) {
    fs.mkdirSync(NOTIFIER_DIR, { recursive: true });
  }
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settingsManager.defaults(), null, 2));
  }
}

function parseValue(raw) {
  const value = String(raw ?? '').trim();
  const lower = value.toLowerCase();

  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null') return null;

  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }

  if (
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']')) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      // Fall through to raw string.
    }
  }

  return value;
}

function parseSetAssignment(input) {
  const eqIndex = input.indexOf('=');
  if (eqIndex <= 0) {
    throw new Error('Expected --set key=value');
  }

  const key = input.slice(0, eqIndex).trim();
  const rawValue = input.slice(eqIndex + 1);

  if (!key) {
    throw new Error('Setting key cannot be empty');
  }

  return { key, value: parseValue(rawValue) };
}

function setNested(target, keyPath, value) {
  const parts = keyPath.split('.').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('Invalid setting key');
  }

  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (typeof cursor[part] !== 'object' || cursor[part] === null || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }

  cursor[parts[parts.length - 1]] = value;
}

function getNested(target, keyPath) {
  const parts = keyPath.split('.').map(p => p.trim()).filter(Boolean);
  let cursor = target;

  for (const part of parts) {
    if (typeof cursor !== 'object' || cursor === null || !(part in cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }

  return cursor;
}

function printUsage() {
  console.log(`
Claude Alert config

Usage:
  npx claude-alert config
  npx claude-alert config --set key=value
  npx claude-alert config --get key
  npx claude-alert config --open

Examples:
  npx claude-alert config --set notificationsEnabled=false
  npx claude-alert config --set autoApproveLevel=medium
  npx claude-alert config --set quietDays='["Saturday","Sunday"]'
  npx claude-alert config --get notificationsEnabled
`);
}

function showConfig() {
  ensureSettingsFile();
  const settings = settingsManager.read();

  console.log(`\nSettings file: ${SETTINGS_PATH}\n`);
  console.log(JSON.stringify(settings, null, 2));
  console.log('\nTip: use `npx claude-alert config --set key=value` to update values.');
}

function setConfig(setArg) {
  ensureSettingsFile();

  const current = settingsManager.read();
  const { key, value } = parseSetAssignment(setArg);

  setNested(current, key, value);

  const validation = settingsManager.validate(current);
  if (!validation.valid) {
    throw new Error(`Invalid settings: ${validation.errors.join('; ')}`);
  }

  settingsManager.write(current);

  console.log(`\n✓ Updated ${key}`);
  console.log(`  New value: ${JSON.stringify(getNested(current, key))}`);
  console.log(`  File: ${SETTINGS_PATH}\n`);
}

function getConfig(key) {
  ensureSettingsFile();

  const current = settingsManager.read();
  const value = getNested(current, key);

  if (value === undefined) {
    throw new Error(`Key not found: ${key}`);
  }

  if (typeof value === 'object' && value !== null) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(String(value));
  }
}

function openConfig() {
  ensureSettingsFile();

  try {
    if (process.env.EDITOR) {
      execFileSync(process.env.SHELL || 'sh', ['-lc', `${process.env.EDITOR} "${SETTINGS_PATH}"`], {
        stdio: 'inherit'
      });
      return;
    }

    if (process.platform === 'darwin') {
      execFileSync('open', [SETTINGS_PATH], { stdio: 'ignore' });
      console.log(`\n✓ Opened ${SETTINGS_PATH}\n`);
      return;
    }

    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${SETTINGS_PATH}'`], {
        stdio: 'ignore'
      });
      console.log(`\n✓ Opened ${SETTINGS_PATH}\n`);
      return;
    }

    execFileSync('xdg-open', [SETTINGS_PATH], { stdio: 'ignore' });
    console.log(`\n✓ Opened ${SETTINGS_PATH}\n`);
  } catch {
    console.log(`\nCould not auto-open settings. Edit this file manually:\n${SETTINGS_PATH}\n`);
  }
}

function main() {
  const args = getArgs();

  if (args.length === 0) {
    showConfig();
    return;
  }

  if (args[0] === '--open') {
    openConfig();
    return;
  }

  if (args[0] === '--set') {
    if (!args[1]) {
      throw new Error('Missing value for --set. Expected key=value');
    }
    setConfig(args[1]);
    return;
  }

  if (args[0] === '--get') {
    if (!args[1]) {
      throw new Error('Missing key for --get');
    }
    getConfig(args[1]);
    return;
  }

  if (args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return;
  }

  throw new Error(`Unknown argument: ${args[0]}`);
}

try {
  main();
} catch (err) {
  console.error(`\n❌ Config command failed: ${err.message}\n`);
  printUsage();
  process.exit(1);
}
