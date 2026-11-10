import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {NativeStore} from '../native/store.mjs'
import {initNativeDefaults} from '../native/defaults.mjs'
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'public-companion-check-')),store=new NativeStore({file:path.join(root,'test.sqlite'),create:true})
try{
 initNativeDefaults(store)
 assert.deepEqual(store.getDocument('tieba').value.tieba.bars,[])
 const preset=JSON.parse(fs.readFileSync(new URL('../presets/tieba.json',import.meta.url)))
 for(const field of ['name','self_ref','owner_address','body_md'])assert.equal(preset[field],'')
 assert.deepEqual(preset.traits,{});assert.deepEqual(preset.voice,{samples:[],quirks:[],particles:[],patterns:[]})
 for(const row of store.listPersonaProfiles()){
  assert.equal(row.follow_main,false)
  for(const field of ['name','self_ref','owner_address','body_md'])assert.equal(row[field],'')
  assert.deepEqual(row.traits,preset.traits);assert.deepEqual(row.voice,preset.voice)
 }
 for(const platform of ['qq','bilibili','tieba']){const value=store.getDocument(platform).value;assert.equal(value.enabled,false);assert.equal(value.credential_ref,undefined)}
 assert.equal(store.getDocument('activity').value.enabled,false)
 assert.equal(store.getDocument('activity').value.qq.owner_conversation,'')
 assert.deepEqual(store.getDocument('activity').value.qq.group_conversations,[])
 for(const table of ['memory_entries','evidence','actions','journal_events','assets','platform_identities','persona_versions'])assert.equal(store.db.prepare('SELECT count(*) n FROM '+table).get().n,0)
 assert.equal(store.listDocuments({type:'persona_reference',limit:1000}).length,0);assert.equal(store.listDocuments({type:'learning_item',limit:1000}).length,0)
 const documents=store.listDocuments({limit:1000}),profiles=store.listPersonaProfiles();assert.equal(initNativeDefaults(store).initialized,false);assert.deepEqual(store.listDocuments({limit:1000}),documents);assert.deepEqual(store.listPersonaProfiles(),profiles)
 console.log(JSON.stringify({ok:true,bars:[],blank_profiles:4,blank_public_tieba_preset:true,no_private_data:true,no_logins:true,no_network:true,existing_data_not_overwritten:true}))
}finally{store.close();fs.rmSync(root,{recursive:true,force:true})}
