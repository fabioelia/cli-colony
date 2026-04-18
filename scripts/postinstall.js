#!/usr/bin/env node
const { execSync } = require('child_process')
const { execFileSync } = require('child_process')

// Rebuild native modules
execSync('electron-rebuild -f -w node-pty', { stdio: 'inherit' })

// macOS only: rename Electron.app to Claude Colony
if (process.platform === 'darwin') {
  const plist = 'node_modules/electron/dist/Electron.app/Contents/Info.plist'
  execFileSync('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Claude Colony', plist])
  execFileSync('plutil', ['-replace', 'CFBundleName', '-string', 'Claude Colony', plist])
}
