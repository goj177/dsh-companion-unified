import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')))
const packed=spawnSync('npm',['pack','--dry-run','--ignore-scripts','--json','--cache',path.join(root,'.runtime','npm-cache')],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(packed.status,0,packed.stderr)
const info=JSON.parse(packed.stdout)[0],files=new Set(info.files.map(row=>row.path))
const forbidden=/(?:^|\/)(?:modules|memory|node_modules|\.runtime|backups?|__pycache__)(?:\/|$)|native\/(?:migrate-|migration|collect-v2|source-snapshot)|\.(?:db|sqlite|class|test|sql|env|pyc|bin|zip|tgz)$/
for(const name of files){assert.ok(!forbidden.test(name),'private/old/converter file shipped: '+name);if(name.startsWith('vendor/'))assert.ok(/\/(?:LICENSE|NOTICE\.md)$/.test(name),'old executable shipped: '+name)}
const runtime=[...files].filter(name=>/\.(?:mjs|js)$/.test(name)&&name!=='client.js')
for(const name of runtime){const body=fs.readFileSync(path.join(root,name),'utf8');assert.ok(!/\/Users\/[^/]+\//.test(body),'original machine path: '+name)
  for(const match of body.matchAll(/(?:from\s*|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g)){const target=path.relative(root,path.resolve(root,path.dirname(name),match[2])).split(path.sep).join('/');assert.ok(files.has(target),'missing packed dependency: '+name+' -> '+target)}
}
assert.ok(files.has('native/protocol/errors.js'));assert.ok(files.has('native/transcribe.py'))
assert.equal((fs.readFileSync(path.join(root,'bundle.patch.yml'),'utf8').match(/\bid:/g)||[]).length,1)
assert.equal(fs.readFileSync(path.join(root,'client.js'),'utf8').match(/window\.__ModuleLoader__\.load\(/g)?.length,1)
await import('../index.js')
console.log(JSON.stringify({ok:true,version:pkg.version,files:files.size,unpacked_bytes:info.unpackedSize,old_runtime_files:0,private_data_files:0,relative_dependencies_complete:true,single_entry:true,single_client:true}))
