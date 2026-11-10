import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {NativeStore} from '../native/store.mjs'
import {initNativeDefaults,nativeDefaultDocuments,NATIVE_WORKSPACE_IDS} from '../native/defaults.mjs'
import {validateDocument} from '../native/contracts.mjs'

const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'native-defaults-')),now=1793192400000,stores=[]
try{
  const open=name=>{const store=new NativeStore({file:path.join(root,name,'native.sqlite'),create:true,now:()=>now});stores.push(store);return store}
  const store=open('fresh'),result=initNativeDefaults(store)
  assert.equal(result.initialized,true);assert.equal(result.profiles,4);assert.equal(result.channels_enabled,false)
  assert.equal(store.getDocument('activity').value.budget.daily_wake_limit,18);assert.equal(store.getDocument('activity').value.budget.daily_token_limit,300000);assert.equal(store.getDocument('activity').value.enabled,false)
  for(const platform of ['qq','bilibili','tieba'])assert.equal(store.getDocument(platform).value.enabled,false)
  assert.equal(store.getDocument('bilibili-inbox').value.enabled,false);assert.deepEqual(store.getDocument('bilibili-inbox').value.channels,[])
  const hormone=store.getDocument('hormone').value;assert.equal(hormone.enabled,true);assert.equal(hormone.mode,'active');assert.equal(hormone.policy.daily_token_budget,13000000)
  const loop=store.getDocument('learning-loop').value;assert.equal(loop.enabled,true);assert.equal(loop.policy.review_interval_minutes,240);assert.equal(loop.policy.review_max_per_day,3);assert.equal(loop.policy.review_sources_per_batch,3)
  assert.deepEqual(store.getDocument('learning-loop-state').value.reviews,[]);assert.deepEqual(store.getDocument('learning-loop-state').value.usages,[])
  assert.ok(store.listPersonaProfiles().every(row=>row.follow_main===false),'fresh platform drafts stay independently blank')
  for(const row of store.listPersonaProfiles()){for(const field of ['name','self_ref','owner_address','body_md'])assert.equal(row[field],'');assert.deepEqual(row.traits,{});for(const field of ['samples','quirks','particles','patterns'])assert.deepEqual(row.voice[field],[])}
  assert.deepEqual(store.getDocument('tieba').value.tieba.bars,[])
  const snapshot=store.listDocuments({limit:1000});assert.equal(initNativeDefaults(store).initialized,false);assert.deepEqual(store.listDocuments({limit:1000}),snapshot)
  const partial=open('partial');partial.createEntity({kind:'person',display_name:'已有资料'});assert.throws(()=>initNativeDefaults(partial),/已有部分资料/)
  const explicit=open('explicit-owner');initNativeDefaults(explicit,{owner:{id:'owner-explicit',display_name:'明确的本机主人',identities:[{namespace:'harness',platform_uid:'local-owner'}]}})
  assert.equal(explicit.getPlatformIdentity('harness','local-owner').entity_id,'owner-explicit');assert.equal(explicit.getPlatformIdentity('harness','local-owner').role,'owner');assert.equal(explicit.getEntity('owner-explicit').metadata.owner_confirmed,true)
  assert.equal(store.getPlatformIdentity('harness','local-owner'),null,'unidentified fresh installs do not infer an owner from display names')
  for(const doc of nativeDefaultDocuments())validateDocument(doc)
  assert.equal(Object.keys(NATIVE_WORKSPACE_IDS).length,4)
  console.log(JSON.stringify({ok:true,freshProfiles:4,documents:result.documents,channelDefaultsDisabled:true,wakeLimit:18,tokenLimit:300000,ownerMustBeExplicit:true,modelCalls:0,networkCalls:0,productionWrites:0},null,2))
}finally{for(const store of stores)store.close();fs.rmSync(root,{recursive:true,force:true})}
