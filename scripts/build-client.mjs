import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sources = ['native/admin-client.js']
const body = '/* 欧鲸鲸统一客户端；由 scripts/build-client.mjs 按顺序拼接，请编辑来源文件。 */\n'
  + sources.map(name => fs.readFileSync(path.join(root, name), 'utf8').trimEnd()).join('\n;\n') + '\n'
assert.equal((body.match(/window\.__ModuleLoader__\.load\(/g) || []).length, 1, '只能注册一个统一客户端')
const output = path.join(root, 'client.js')
if (process.argv.includes('--check')) {
  assert.equal(fs.readFileSync(output, 'utf8'), body, 'client.js 未同步，请运行 npm run build:client')
  console.log('PASS single native settings client is current')
} else {
  fs.writeFileSync(output, body)
  console.log('已拼接唯一客户端 client.js')
}
