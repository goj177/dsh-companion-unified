/** Fresh native installations only. Existing data is migrated explicitly by the bootstrap, never guessed here. */
import {NativeStore,NATIVE_TABLES} from './store.mjs'
import {validateDocument,validatePersona,isPlainObject} from './contracts.mjs'
import {createHash} from 'node:crypto'
import {HORMONE_DEFAULTS} from './hormone.mjs'
import {LEARNING_LOOP_DEFAULTS,freshLearningLoopState} from './learning-loop.mjs'

export const NATIVE_WORKSPACE_IDS=Object.freeze({main:'workspace:main',qq:'workspace:qq',bilibili:'workspace:bilibili',tieba:'workspace:tieba'})
const profile=platform=>({id:'persona-'+platform,platform,follow_main:false,...(platform!=='main'?{main_profile_id:'persona-main'}:{}),name:'',self_ref:'',owner_address:'',body_md:'',
  traits:{},voice:{samples:[],quirks:[],particles:[],patterns:[]}})
export function nativeDefaultDocuments({owner_entity_id}={}){
  const make=(id,type,value)=>({id,type,schema_id:'companion.'+type,schema_version:1,value})
  return [
    make('settings','settings',{enabled:true,time_zone:'Asia/Shanghai',default_persona_id:'persona-main',activity_document_id:'activity',mood_document_id:'mood',speech_document_id:'speech',learning_document_id:'learning',platform_document_ids:{qq:'qq',tieba:'tieba',bilibili:'bilibili'},
      familiarity:{sharing:'global',score_version:'native_contacts_v1',max_people:3,max_context_chars:180,public_summary_enabled:true},
      memory:{enabled:true,hit_limit:2,prompt_language:'zh',max_injection_chars:1800,consolidation_enabled:true,consolidation_batches_per_day:2,consolidation_source_limit:8,consolidation_max_chars:4800,backup_enabled:false,disabled_workspace_ids:[]}}),
    make('activity','activity',{enabled:false,time_zone:'Asia/Shanghai',holidays:[],budget:{daily_wake_limit:18,daily_token_limit:300000,reserve_tokens:10000,human_reserve_tokens:3000,max_task_tokens:30000,max_steps:8,urgent_human_allowed:true,money_budget_enabled:false,daily_cost_limit_fen:500},
      batching:{batch_ms:30000,human_batch_ms:0,max_batch:5,max_concurrent:3,max_per_platform:1,lease_ms:900000,task_timeout_ms:600000,min_valley_remaining_ms:120000},idle:{enabled:true,min_idle_ms:2700000,explore_every_ms:5400000,chat_every_ms:7200000,explore_platforms:['bilibili','tieba'],qq_targets:['owner','group']},
      qq:{owner_conversation:'',group_conversations:[],profile_authorized:false,quiet_start_hour:1,quiet_end_hour:8},model:{reasoning_effort:'low',max_output_tokens:1800,peak_max_output_tokens:900},mood_judge:{min_interval_minutes:240,max_per_day:3,reserve_tokens:5000}}),
    make('activity:state','activity_state',{idle:{last_activity_at:0,next_explore_at:0,next_chat_at:0,explore_cursor:0,chat_cursor:0},blocks:[]}),
    make('mood','mood',{enabled:true,shared:true,self_profile_id:'persona-main',...(owner_entity_id?{owner_entity_id}:{}),owner_address:'主人',policy:{baseline:70,floor:0,decay_half_hours:12,auto_judge:true,inject_mode:'event',inject_confidence:60,significant_delta:3,significant_dimension_delta:5,inject_per_day:6}}),
    make('hormone','hormone',structuredClone(HORMONE_DEFAULTS)),
    make('speech','speech',{enabled:true,level:'standard',repetition_hints:true}),make('speech-state','speech_state',{version:1,buckets:[]}),
    make('learning','learning',{enabled:true,evidence_required:true,shared_interests:true,max_reflections_per_task:2,max_context_chars:400,max_topics:1000,active_revision:0}),
    make('learning-state','learning_state',{revision:0,observations:0,updated_at:0,topics:[],questions:[],suggestions:[],versions:[{revision:0,created_at:0,suggestion_ids:[]}]}),
    make('learning-loop','learning_loop',structuredClone(LEARNING_LOOP_DEFAULTS)),make('learning-loop-state','learning_loop_state',freshLearningLoopState(0)),
    make('qq','platform_settings',{platform:'qq',enabled:false,account_entity_id:'account-qq',qq:{
      transport:{mode:'reverse',url:'ws://127.0.0.1:3001',host:'127.0.0.1',port:8643,reconnect_max_attempts:100},
      access:{admin_uids:[],dm_policy:'disabled',allowed_private_uids:[],group_policy:'disabled',allowed_group_uids:[],require_mention:true,ignore_self:true,allow_all_users:false,restricted_member_prefix:true},
      conversation:{new_message_policy:'queue',auto_steer_policy:'admin',rate_limit_per_minute:30,interim_messages:true,send_error_notice:true,agent_preset_id:'',workspace_id:NATIVE_WORKSPACE_IDS.qq,unknown_command:'intercept',interim_recall:true,interim_recall_ms:90000,deferred_timeout_ms:600000,chat_idle_evict_days:7},
      media:{text_image_threshold:150,stt_enabled:true,stt_model:'small',asset_collection_id:'qq-media',temp_ttl_hours:6,outbound_image_max_bytes:8388608,inbound_image_max_px:2048,max_voice_bytes:15728640,max_file_bytes:20971520,inbound_file_max_bytes:20971520,allow_private_hosts:false,stt_engine:'auto',stt_args:[],stt_timeout_ms:60000,card_footer:'欧鲸鲸',font_files:[],font_families:[]},
      moderation:{enabled:false,allowed_group_uids:[],allow_local_owner:false,default_duration_seconds:600,nickname_fuzzy_match:true,max_duration_seconds:2592000,command_ttl_ms:120000},
      writes:{per_minute:20,per_day:500},diagnostics:{log_level:'info',trace_enabled:false,action_audit_enabled:true,sensitive_patterns:[],trace_level:'debug',record_inbound:false,inbox_redact:false},dedup_window_seconds:300}}),
    make('bilibili','platform_settings',{platform:'bilibili',enabled:false,account_entity_id:'account-bilibili',bilibili:{limits:{read_per_round:5,reply_per_round:3},interaction:{reply_to_comments:true,comment_sample_size:6},preferences:{like:[],dislike:[],keywords:[]},permissions:{comment:false,dynamic:false,mood_context:true,stickers:true,direct_message:false,live_danmaku:false},
      sharing:{enabled:false,via:'qq',min_score:13,silent_after_days:3,ai_comment_guard:false,ai_threshold:30,daily_limit:3,qq_document_id:'qq',private_recipient_uid:'',group_recipient_uid:''},transcription:{enabled:false,model:'small'},risk:{min_gap_ms:1200,read_hourly:100,read_daily:500,write_hourly:10,write_daily:30,reply_daily:30,write_gap_ms:60000,dm_gap_ms:60000},diary:{enabled:true,push_enabled:false},notification:{channel:'none',template:''},session:{rotation_days:3,persona_once_per_session:true},inbox_document_id:'bilibili-inbox'}}),
    make('bilibili-inbox','inbox',{platform:'bilibili',enabled:false,channels:[],poll_interval_ms:180000,scope:'both',all_day:true,once_per_person:false,mention_summary:true,room_uid:'',live_scope:'owner',dm_scope:'owner',dm_allowed_uids:[],dm_seed_on_start:true,live_ignore_uids:[],live_seed_on_start:true}),
    make('tieba','platform_settings',{platform:'tieba',enabled:false,account_entity_id:'account-tieba',tieba:{bars:[],keywords:[],permissions:{sign:false,follow:false,sign_all_followed:false,reply:false,answer_questions:true,sub_reply:false,new_thread:false,images:false,experimental_image_post:false,direct_message:false},inbox:{enabled:false,poll_interval_ms:180000,seed_on_start:true,allow_legacy_auth:false,daily_limit:30,gap_ms:60000},comment_inbox:{enabled:false,poll_interval_ms:60000,seed_on_start:true,max_pages:10},limits:{read_per_round:5,reply_per_round:1,reply_per_day:5,sub_reply_per_round:1,sub_reply_per_day:3,new_thread_per_day:1,image_per_day:10,reply_gap_ms:30000},requests:{gap_ms:1200,breaker_ms:1800000,dedupe_days:7},learning:{persona_evolution_enabled:false,hot_only:true,bar_style_enabled:false},diary:{enabled:true,private_enabled:true},expression:{tone_gate_enabled:true,mention_name:'',mention_uid:'',mention_every_reply:false}}}),
    ...['qq','bilibili','tieba'].map(platform=>make('platform-state-'+platform,'platform_state',{platform,paused_until:null,verification_required:false,verification_reason:''})),
    make('style-library-tieba','tieba_style_library',{platform:'tieba',historical:false,bars:[]}),make('bar-styles-tieba','tieba_bar_styles',{platform:'tieba',historical:false,bars:[]}),
    ...Object.entries(NATIVE_WORKSPACE_IDS).map(([platform,workspace_id])=>make('workspace-persona:'+createHash('sha256').update(workspace_id).digest('hex'),'workspace_persona_binding',{workspace_id,platform,enabled:true})),
  ]
}
export function initNativeDefaults(store,{now=store?.now?.(),owner}={}){
  if(!(store instanceof NativeStore)||store.readOnly||!Number.isSafeInteger(now)||now<0)throw new Error('新安装默认值需要明确可写原生库和时间')
  if(store.getDocument('settings'))return {initialized:false,status:'already_initialized'}
  const dataTables=NATIVE_TABLES.filter(table=>table!=='schema_meta');if(dataTables.some(table=>store.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n>0))throw new Error('原生库已有部分资料，需显式恢复或迁移；不以默认稿覆盖')
  if(owner!==undefined&&(!isPlainObject(owner)||Object.keys(owner).some(key=>!['id','display_name','identities'].includes(key))||typeof owner.id!=='string'||typeof owner.display_name!=='string'||!Array.isArray(owner.identities??[])))throw new Error('主人必须由本机安装流程显式提供实体与身份')
  const profiles=['main','qq','bilibili','tieba'].map(profile)
  for(const row of profiles)validatePersona(row);const docs=nativeDefaultDocuments({owner_entity_id:owner?.id});for(const doc of docs)validateDocument(doc)
  return store.transaction(()=>{
    if(owner){store.createEntity({id:owner.id,kind:'person',display_name:owner.display_name,metadata:{owner_confirmed:true,confirmed_by:'explicit_native_installation'}});for(const row of owner.identities??[]){if(!isPlainObject(row)||Object.keys(row).some(key=>!['namespace','platform_uid','display_name'].includes(key)))throw new Error('主人身份字段无效');store.upsertPlatformIdentity({...row,entity_id:owner.id,role:'owner'})}}
    for(const platform of ['qq','bilibili','tieba'])store.createEntity({id:'account-'+platform,kind:'account',display_name:platform+'待绑定账号'})
    for(const row of profiles)store.putPersonaProfile({...row,created_at:now,updated_at:now});for(const doc of docs)store.putDocument(doc)
    return {initialized:true,profiles:profiles.length,documents:docs.length,channels_enabled:false,budget:{daily_wake_limit:18,daily_token_limit:300000},owner_bound:!!owner}
  })
}
