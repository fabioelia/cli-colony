import { ipcMain, clipboard } from 'electron'
import { promises as fsp } from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { join } from 'path'
import { colonyPaths } from '../../shared/colony-paths'

export function registerFsHandlers(): void {
  ipcMain.handle('fs:listDir', async (_e, dirPath: string, depth: number = 2) => {
    interface FileNode {
      name: string
      path: string
      type: 'file' | 'directory'
      children?: FileNode[]
    }

    const IGNORE = new Set(['.git', 'node_modules', '.next', '__pycache__', '.venv', 'venv',
      '.DS_Store', '.claude', 'dist', 'build', 'out', '.cache', 'coverage', '.turbo', '.nuxt'])

    async function scan(dir: string, currentDepth: number): Promise<FileNode[]> {
      try {
        const entries = (await fsp.readdir(dir, { withFileTypes: true }))
          .filter((e) => !e.name.startsWith('.') || e.name === '.env' || e.name === '.github')
          .filter((e) => !IGNORE.has(e.name))
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1
            if (!a.isDirectory() && b.isDirectory()) return 1
            return a.name.localeCompare(b.name)
          })

        const nodes: FileNode[] = []
        for (const e of entries) {
          const fullPath = path.join(dir, e.name)
          const isDir = e.isDirectory()
          const node: FileNode = { name: e.name, path: fullPath, type: isDir ? 'directory' : 'file' }
          if (isDir && currentDepth < depth) {
            node.children = await scan(fullPath, currentDepth + 1)
          }
          nodes.push(node)
        }
        return nodes
      } catch {
        return []
      }
    }

    return scan(dirPath, 0)
  })

  ipcMain.handle('fs:pasteClipboardImage', async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const tmpDir = colonyPaths.screenshots
    await fsp.mkdir(tmpDir, { recursive: true })
    const fileName = `screenshot-${Date.now()}.png`
    const filePath = join(tmpDir, fileName)
    await fsp.writeFile(filePath, img.toPNG())
    return filePath
  })

  ipcMain.handle('fs:saveClipboardImage', async (_e, base64Data: string) => {
    const tmpDir = colonyPaths.screenshots
    await fsp.mkdir(tmpDir, { recursive: true })
    const fileName = `screenshot-${Date.now()}.png`
    const filePath = join(tmpDir, fileName)
    const buffer = Buffer.from(base64Data, 'base64')
    await fsp.writeFile(filePath, buffer)
    return filePath
  })

  ipcMain.handle('fs:searchContent', async (_e, dirPath: string, query: string, ignoreDirs?: string[]) => {

    if (!query || query.length < 2) return []

    interface SearchResult {
      file: string
      matches: Array<{ line: number; text: string }>
    }

    const defaultExclude = ['--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=.next',
      '--exclude-dir=__pycache__', '--exclude-dir=.venv', '--exclude-dir=venv',
      '--exclude-dir=dist', '--exclude-dir=build', '--exclude-dir=out',
      '--exclude-dir=.cache', '--exclude-dir=coverage', '--exclude-dir=.turbo', '--exclude-dir=.nuxt']
    const customExclude = (ignoreDirs || []).map((d) => `--exclude-dir=${d}`)
    const includes = [
      '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx',
      '--include=*.py', '--include=*.rs', '--include=*.go', '--include=*.java',
      '--include=*.md', '--include=*.json', '--include=*.yaml', '--include=*.yml',
      '--include=*.css', '--include=*.scss', '--include=*.html', '--include=*.sql',
      '--include=*.sh', '--include=*.toml', '--include=*.cfg', '--include=*.txt',
      '--include=*.rb', '--include=*.php', '--include=*.swift', '--include=*.c',
      '--include=*.cpp', '--include=*.h', '--include=*.xml', '--include=*.vue',
      '--include=*.svelte', '--include=*.graphql', '--include=*.proto',
    ]

    const args = ['-rni', '-m', '5', ...defaultExclude, ...customExclude, ...includes, '--', query, dirPath]

    return new Promise<SearchResult[]>((resolve) => {
      execFile('grep', args, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (!stdout) {
          resolve([])
          return
        }
        const byFile = new Map<string, Array<{ line: number; text: string }>>()
        for (const line of stdout.split('\n')) {
          const match = line.match(/^(.+?):(\d+):(.*)$/)
          if (!match) continue
          const [, file, lineNum, text] = match
          if (!byFile.has(file)) byFile.set(file, [])
          byFile.get(file)!.push({ line: parseInt(lineNum, 10), text: text.trim().slice(0, 200) })
        }
        const results: SearchResult[] = []
        for (const [file, matches] of byFile) {
          results.push({ file, matches })
        }
        resolve(results)
      })
    })
  })

  ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
    try {
      const stat = await fsp.stat(filePath)
      if (stat.size > 1024 * 1024) return { error: 'File too large (>1MB)' }
      return { content: await fsp.readFile(filePath, 'utf-8') }
    } catch (err: any) {
      return { error: err.message }
    }
  })
}
