#!/usr/bin/env node
// Render the raster brand assets from their sources in brand/:
//   brand/og.html          → public/og.png               (1200 × 630 social card)
//   brand/touch-icon.html  → public/apple-touch-icon.png (180 × 180, from public/favicon.svg)
//
// Run from apps/web:  node scripts/brand.mjs   (needs network for Google Fonts)
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './chrome.mjs';

const root = resolve(import.meta.dirname, '..');
const url = (path) => pathToFileURL(resolve(root, path)).href;

const chrome = await launch();
try {
  await chrome.shoot({ url: url('brand/og.html'), file: resolve(root, 'public/og.png'), width: 1200, height: 630, settleMs: 2500 });
  console.log('ok   public/og.png');
  await chrome.shoot({
    url: url('brand/touch-icon.html'),
    file: resolve(root, 'public/apple-touch-icon.png'),
    width: 180,
    height: 180,
    settleMs: 500,
  });
  console.log('ok   public/apple-touch-icon.png');
} finally {
  await chrome.close();
}
