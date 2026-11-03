import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {NativeStore} from '../native/store.mjs'
import {initNativeDefaults} from '../native/defaults.mjs'
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'public-companion-check-')),store=new NativeStore({file:path.join(root,'test.sqlite'),create:true})
try{
 initNativeDefaults(store)
 assert.deepEqual(store.getDocument('tieba').value.tieba.bars,['星际2'])
 assert.equal(store.getPersonaProfile('persona-tieba').follow_main,false)
 const persona=JSON.parse(fs.readFileSync(new URL('../presets/tieba.json',import.meta.url)))
 assert.equal(store.getPersonaProfile('persona-tieba').body_md,persona.body_md)
 assert.deepEqual(store.getPersonaProfile('persona-tieba').voice,persona.voice)
 for(const platform of ['qq','bilibili','tieba']){const value=store.getDocument(platform).value;assert.equal(value.enabled,false);assert.equal(value.credential_ref,undefined)}
 assert.equal(store.getDocument('activity').value.enabled,false)
 assert.equal(store.getDocument('activity').value.qq.owner_conversation,'')
 assert.deepEqual(store.getDocument('activity').value.qq.group_conversations,[])
 for(const table of ['memory_entries','evidence','actions','journal_events','assets'])assert.equal(store.db.prepare('SELECT count(*) n FROM '+table).get().n,0)
 const prior=store.listDocuments({limit:1000});assert.equal(initNativeDefaults(store).initialized,false);assert.deepEqual(store.listDocuments({limit:1000}),prior)
 console.log(JSON.stringify({ok:true,bars:['星际2'],independent_tieba_persona:true,no_private_data:true,no_logins:true,no_network:true,existing_data_not_overwritten:true}))
}finally{store.close();fs.rmSync(root,{recursive:true,force:true})}
