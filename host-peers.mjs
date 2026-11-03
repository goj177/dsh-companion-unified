import fs from 'node:fs'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

// Internal channel code uses the running host's SDK. Never install a second
// copy of its agent/session classes or bake the original computer's app path.
const installed = Symbol.for('dsh-companion-unified.host-peer-resolution')
export function installHostPeerResolution() {
  if (globalThis[installed]) return globalThis[installed]
  const locations = []
  const add = file => { if (typeof file === 'string' && path.isAbsolute(file) && fs.existsSync(file)) locations.push(file) }
  add(process.argv[1])
  const resources = [process.resourcesPath,
    process.platform === 'darwin' ? path.resolve(path.dirname(process.execPath), '../Resources') : path.join(path.dirname(process.execPath), 'resources')]
  for (const root of resources.filter(Boolean)) {
    add(path.join(root, 'app.asar', 'dsh', 'package.json'))
    add(path.join(root, 'app', 'dsh', 'package.json'))
  }
  const hostRequires = [...new Set(locations)].map(file => createRequire(pathToFileURL(file)))
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context) }
      catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND' || !/^@deepseek-ai\/(?:dsh-[a-z0-9-]+|cordis)(?:\/|$)/.test(specifier)) throw error
        for (const hostRequire of hostRequires) {
          let target
          try { target = hostRequire.resolve(specifier) } catch { continue }
          return nextResolve(pathToFileURL(target).href, context)
        }
        error.message += '\n欧鲸鲸需从正在运行的 DeepSeek Harness 入口读取宿主 SDK；请在 Harness profile 内安装该插件。'
        throw error
      }
    },
  })
  globalThis[installed] = hook
  return hook
}
installHostPeerResolution()
