#!/usr/bin/env node
const { execSync } = require('child_process')
const { execFileSync } = require('child_process')

// Rebuild native modules
execSync('electron-rebuild -f -w node-pty', { stdio: 'inherit' })

// macOS only: rename Electron.app to Claude Colony
if (process.platform === 'darwin') {
  const fs = require('fs')
  const plist = 'node_modules/electron/dist/Electron.app/Contents/Info.plist'
  if (fs.existsSync(plist)) {
    execFileSync('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Claude Colony', plist])
    execFileSync('plutil', ['-replace', 'CFBundleName', '-string', 'Claude Colony', plist])
  } else {
    console.warn('⚠ Electron Info.plist not found — skipping app name patch. Run "node node_modules/electron/install.js" then re-run postinstall.')
  }
}
