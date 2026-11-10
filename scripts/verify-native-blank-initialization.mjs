import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {NativeStore,NATIVE_TABLES} from '../native/store.mjs'
import {initNativeDefaults} from '../native/defaults.mjs'
import {NativeProfileService} from '../native/profile-service.mjs'
import {NativeMemory} from '../native/memory.mjs'
import {validatePersona} from '../native/contracts.mjs'

const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'native-blank-initialization-')),store=new NativeStore({file:path.join(root,'native.sqlite'),create:true,now:()=>1794300000000}),profiles=new NativeProfileService({store}),snapshot=()=>Object.fromEntries(NATIVE_TABLES.map(table=>[table,store.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])),emptyVoice={samples:[],quirks:[],particles:[],patterns:[]}
try{
 const initialized=initNativeDefaults(store);assert.equal(initialized.initialized,true)
 for(const platform of ['main','qq','bilibili','tieba']){
  const row=store.getPersonaProfile('persona-'+platform);for(const field of ['name','self_ref','owner_address','body_md'])assert.equal(row[field],'',platform+'.'+field)
  assert.deepEqual(row.traits,{});assert.deepEqual(row.voice,emptyVoice);assert.equal(row.follow_main,false);assert.equal(profiles.resolve(platform).effective_profile_id,row.id)
  assert.ok(!/欧鲸鲸|大肥鱼|孙笑川|嘴硬|阴阳|参考句：|性格参数：/.test(profiles.render(platform)),'blank rendering must not restore an implicit named persona')
 }
 assert.deepEqual(store.getDocument('tieba').value.tieba.bars,[])
 for(const platform of ['qq','bilibili','tieba'])assert.equal(store.getDocument(platform).value.enabled,false)
 for(const table of ['memory_entries','evidence','journal_events','platform_identities','persona_versions','assets','actions'])assert.equal(store.db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0,'fresh personal data must stay empty: '+table)
 assert.equal(store.listDocuments({type:'persona_reference',limit:1000}).length,0);assert.equal(store.listDocuments({type:'learning_item',limit:1000}).length,0)
 const row=store.getPersonaProfile('persona-main'),input=Object.fromEntries(Object.entries(row).filter(([key])=>key!=='revision'));assert.doesNotThrow(()=>validatePersona({...input,name:''}));for(const name of [null,123,'x'.repeat(161)])assert.throws(()=>validatePersona({...input,name}));assert.throws(()=>validatePersona({...input,platform:'invalid'}));assert.throws(()=>store.putPersonaProfile({...input,id:'../invalid',expected_revision:row.revision}),'empty names do not weaken persona identity IDs')
 store.createEntity({id:'fixture-owner',kind:'person',display_name:'合成主人'});store.upsertPlatformIdentity({namespace:'qq',platform_uid:'1001',entity_id:'fixture-owner',role:'owner',display_name:'合成主人'})
 const memory=new NativeMemory(store),context={platform:'qq',conversation_id:'private:1001',actor_uid:'1001',actor_entity_id:'fixture-owner',owner_authorized:true,include_secret:false},source=memory.recordEvidence({platform:'qq',conversation_id:context.conversation_id,actor_uid:context.actor_uid,actor_entity_id:context.actor_entity_id,direction:'in',kind:'statement',text:'我喜欢喝绿茶。',source_at:1794300000000,source_type:'user',visibility:'owner',source:{kind:'user_statement',explicit:true}})
 const remembered=memory.remember({level:'user',entity_type:'person',subject:'合成主人',predicate:'喜欢的饮料',object:'绿茶',content:'我喜欢喝绿茶。',memory_type:'asserted',evidence_ids:[source.id],scope:'global'},context);assert.equal(remembered.status,'active')
 profiles.save('main',{name:'已有本机名字',self_ref:'我',owner_address:'已有称呼',body_md:'只属于本机的既有稿',traits:{sharp:8},voice:{samples:['本机既有参考句']},expected_revision:row.revision,reason:'合成已有安装保护验收'},{owner_authorized:true})
 const before=snapshot();assert.equal(initNativeDefaults(store).status,'already_initialized');assert.deepEqual(snapshot(),before,'an existing installation must keep all persona, settings and personal records byte-for-byte')
 console.log(JSON.stringify({ok:true,fresh_blank_profiles:4,blank_names_bodies_traits_and_voice:true,no_implicit_named_persona:true,default_bars_empty:true,accounts_and_personal_data_empty:true,existing_installation_preserved:true,identity_validation_retained:true,real_model_calls:0,real_network_calls:0,production_writes:0}))
}finally{store.close();fs.rmSync(root,{recursive:true,force:true})}
