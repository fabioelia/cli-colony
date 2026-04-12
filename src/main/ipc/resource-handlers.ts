import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { resolveCommand } from '../resolve-command'
import { getAllInstances } from '../instance-manager'

export function registerResourceHandlers(): void {
  ipcMain.handle('resources:getUsage', async () => {
    const instances = await getAllInstances()
    const pids = instances
      .filter((i) => i.pid && i.status === 'running')
      .map((i) => ({ id: i.id, pid: i.pid! }))

    if (pids.length === 0) {
      return { perInstance: {}, total: { cpu: 0, memory: 0 } }
    }

    return new Promise<{
      perInstance: Record<string, { cpu: number; memory: number }>
      total: { cpu: number; memory: number }
    }>((resolve) => {
      const pidList = pids.map((p) => p.pid).join(',')
      execFile(resolveCommand('ps'), ['-o', 'pid,ppid,%cpu,rss', '-p', pidList], { timeout: 5000 }, (err, stdout) => {
        const perInstance: Record<string, { cpu: number; memory: number }> = {}
        let totalCpu = 0
        let totalMem = 0

        if (!err && stdout) {
          const lines = stdout.trim().split('\n').slice(1)
          for (const line of lines) {
            const parts = line.trim().split(/\s+/)
            if (parts.length < 4) continue
            const pid = parseInt(parts[0], 10)
            const cpu = parseFloat(parts[2]) || 0
            const rss = parseInt(parts[3], 10) || 0
            const memMB = rss / 1024

            const entry = pids.find((p) => p.pid === pid)
            if (entry) {
              perInstance[entry.id] = { cpu, memory: Math.round(memMB * 10) / 10 }
              totalCpu += cpu
              totalMem += memMB
            }
          }
        }

        execFile(resolveCommand('ps'), ['-eo', 'pid,ppid,%cpu,rss'], { timeout: 5000 }, (err2, stdout2) => {
          if (!err2 && stdout2) {
            const pidSet = new Set(pids.map((p) => p.pid))
            const pidToInstance = new Map<number, string>()
            for (const p of pids) pidToInstance.set(p.pid, p.id)

            const lines = stdout2.trim().split('\n').slice(1)
            for (const line of lines) {
              const parts = line.trim().split(/\s+/)
              if (parts.length < 4) continue
              const pid = parseInt(parts[0], 10)
              const ppid = parseInt(parts[1], 10)

              if (!pidSet.has(pid) && pidToInstance.has(ppid)) {
                const cpu = parseFloat(parts[2]) || 0
                const rss = parseInt(parts[3], 10) || 0
                const memMB = rss / 1024
                const instanceId = pidToInstance.get(ppid)!

                if (perInstance[instanceId]) {
                  perInstance[instanceId].cpu += cpu
                  perInstance[instanceId].memory += Math.round(memMB * 10) / 10
                }
                totalCpu += cpu
                totalMem += memMB
              }
            }
          }

          resolve({
            perInstance,
            total: {
              cpu: Math.round(totalCpu * 10) / 10,
              memory: Math.round(totalMem * 10) / 10,
            },
          })
        })
      })
    })
  })
}
