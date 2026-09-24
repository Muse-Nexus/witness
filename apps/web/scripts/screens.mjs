#!/usr/bin/env node
// Capture README screenshots of the web app with headless Chrome.
//
// 1. Start the app with synthetic data:   VITE_MOCK_API=1 bunx vite --port 5391
// 2. Run:                                  node scripts/screens.mjs [outDir] [--full]
//
// Every screen uses the in-memory mock API, so no real data can appear in a screenshot.
// The viewport and prefers-color-scheme are emulated the way a phone or a light-mode
// desktop reports them. Set CHROME if your Chrome/Chromium lives somewhere else.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch } from './chrome.mjs';

const BASE = process.env.BASE_URL ?? 'http://localhost:5391';
const args = process.argv.slice(2);
const fullPage = args.includes('--full');
const outDir = resolve(args.find((a) => !a.startsWith('--')) ?? '../../docs/assets/screens');

const PAGES = [
  { name: 'landing', path: '/' },
  { name: 'home', path: '/app' },
  { name: 'setup', path: '/app/setup' },
  { name: 'settings', path: '/app/settings' },
];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, scale: 1, mobile: false },
  { name: 'mobile', width: 390, height: 844, scale: 2, mobile: true },
];
const THEMES = ['dark', 'light'];

mkdirSync(outDir, { recursive: true });
const chrome = await launch();
let failed = 0;
try {
  for (const page of PAGES) {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        const file = join(outDir, `${page.name}-${viewport.name}-${theme}.png`);
        try {
          await chrome.shoot({ url: `${BASE}${page.path}`, file, theme, fullPage, ...viewport });
          console.log(`ok   ${file}`);
        } catch (error) {
          failed++;
          console.log(`FAIL ${file}: ${error.message}`);
        }
      }
    }
  }
} finally {
  await chrome.close();
}
process.exitCode = failed ? 1 : 0;
