import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { NATIVE_FORMAT, NATIVE_SCHEMA_VERSION, NATIVE_APPLICATION_ID, isPlainObject,
  DOCUMENT_CONTRACTS, validateJson, stringifyJson, validateDocument, validatePersona } from './contracts.mjs'

/** One native schema. There is deliberately no legacy table/file detection path. */
export const NATIVE_DDL = `
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE documents (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, schema_id TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version>0),
  value_json TEXT NOT NULL CHECK(json_valid(value_json) AND json_type(value_json)='object'),
  revision INTEGER NOT NULL CHECK(revision>0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_documents_type ON documents(type,id);
CREATE TABLE persona_profiles (
  id TEXT PRIMARY KEY, platform TEXT NOT NULL UNIQUE CHECK(platform IN ('main','qq','tieba','bilibili')),
  follow_main INTEGER NOT NULL CHECK(follow_main IN (0,1)), main_profile_id TEXT REFERENCES persona_profiles(id),
  name TEXT NOT NULL, self_ref TEXT NOT NULL, owner_address TEXT NOT NULL, body_md TEXT NOT NULL,
  traits_json TEXT NOT NULL CHECK(json_valid(traits_json) AND json_type(traits_json)='object'),
  voice_json TEXT NOT NULL CHECK(json_valid(voice_json) AND json_type(voice_json)='object'),
  revision INTEGER NOT NULL CHECK(revision>0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(platform<>'main' OR (follow_main=0 AND main_profile_id IS NULL)),
  CHECK(follow_main=0 OR main_profile_id IS NOT NULL)
) STRICT;
CREATE TABLE persona_versions (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES persona_profiles(id), version INTEGER NOT NULL CHECK(version>0),
  name TEXT NOT NULL, self_ref TEXT NOT NULL, owner_address TEXT NOT NULL, body_md TEXT NOT NULL,
  traits_json TEXT NOT NULL CHECK(json_valid(traits_json) AND json_type(traits_json)='object'),
  voice_json TEXT NOT NULL CHECK(json_valid(voice_json) AND json_type(voice_json)='object'),
  follow_main INTEGER NOT NULL CHECK(follow_main IN (0,1)), main_profile_id TEXT REFERENCES persona_profiles(id),
  reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','archived')), created_at INTEGER NOT NULL,
  UNIQUE(profile_id,version)
) STRICT;
CREATE TABLE entities (
  id TEXT PRIMARY KEY, short_ref TEXT UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('person','account','self','topic','organization','source','object','place')),
  display_name TEXT NOT NULL, summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(short_ref IS NULL OR (substr(short_ref,1,1)='p' AND length(short_ref) BETWEEN 2 AND 20
    AND substr(short_ref,2) NOT GLOB '*[^0-9]*' AND (substr(short_ref,2)='0' OR substr(short_ref,2,1) BETWEEN '1' AND '9')))
) STRICT;
CREATE TABLE platform_identities (
  id TEXT PRIMARY KEY, namespace TEXT NOT NULL, platform_uid TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id),
  role TEXT NOT NULL CHECK(role IN ('person','account','owner')), display_name TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(namespace,platform_uid)
) STRICT;
CREATE INDEX idx_platform_identities_entity ON platform_identities(entity_id,namespace);
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY, semantic_key TEXT NOT NULL UNIQUE, entity_key TEXT NOT NULL,
  level TEXT NOT NULL, entity_type TEXT NOT NULL, subject TEXT NOT NULL,
  actor_entity_id TEXT REFERENCES entities(id), actor_uid TEXT NOT NULL DEFAULT '', predicate TEXT NOT NULL,
  object TEXT NOT NULL, content TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(keywords_json) AND json_type(keywords_json)='array'),
  project TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL DEFAULT '', importance INTEGER NOT NULL DEFAULT 1 CHECK(importance>=0),
  corrected INTEGER NOT NULL DEFAULT 0 CHECK(corrected IN (0,1)), subcategory TEXT NOT NULL DEFAULT '', source_session_id TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'owner' CHECK(visibility IN ('public','conversation','owner','secret')), platform TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '', memory_type TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
  source_at INTEGER, valid_from INTEGER, valid_until INTEGER, priority INTEGER NOT NULL DEFAULT 0,
  heat REAL NOT NULL DEFAULT 1, hit_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  CHECK(visibility<>'conversation' OR (platform<>'' AND conversation_id<>''))
) STRICT;
CREATE INDEX idx_memory_scope_status_time ON memory_entries(scope,status,source_at DESC);
CREATE INDEX idx_memory_entity_predicate ON memory_entries(entity_key,predicate,status);
CREATE INDEX idx_memory_project ON memory_entries(project,level,status);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, platform TEXT NOT NULL, conversation_id TEXT NOT NULL DEFAULT '',
  actor_entity_id TEXT REFERENCES entities(id), actor_uid TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', source_message_id TEXT NOT NULL DEFAULT '',
  source_at INTEGER, source_time_raw TEXT NOT NULL DEFAULT '', recorded_at INTEGER NOT NULL, status TEXT NOT NULL,
  confirmation TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','conversation','owner','secret')),
  source_type TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json) AND json_type(source_json)='object'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object')
) STRICT;
CREATE INDEX idx_evidence_context_time ON evidence(platform,conversation_id,source_at DESC);
CREATE INDEX idx_evidence_status_time ON evidence(status,visibility,source_at DESC);
CREATE TABLE relations (
  id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, relation TEXT NOT NULL,
  object_kind TEXT NOT NULL, object_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
  UNIQUE(subject_kind,subject_id,relation,object_kind,object_id)
) STRICT;
CREATE INDEX idx_relations_subject ON relations(subject_kind,subject_id,relation);
CREATE INDEX idx_relations_object ON relations(object_kind,object_id,relation);
CREATE TABLE journal_events (
  id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, platform TEXT NOT NULL,
  entity_id TEXT REFERENCES entities(id), actor_uid TEXT NOT NULL DEFAULT '', conversation_id TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL, status TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'owner' CHECK(visibility IN ('public','conversation','owner','secret')),
  text TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '',
  source_at INTEGER, source_time_raw TEXT NOT NULL DEFAULT '', source_type TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
  CHECK(visibility<>'conversation' OR conversation_id<>'')
) STRICT;
CREATE INDEX idx_journal_context_time ON journal_events(platform,conversation_id,source_at DESC);
CREATE INDEX idx_journal_entity_time ON journal_events(entity_id,event_type,source_at DESC);
CREATE INDEX idx_journal_type_time ON journal_events(event_type,status,source_at DESC);
CREATE TABLE actions (
  id TEXT PRIMARY KEY, platform TEXT NOT NULL, kind TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK(json_valid(target_json) AND json_type(target_json)='object'), body TEXT NOT NULL,
  body_digest TEXT NOT NULL CHECK(length(body_digest)=64), request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
  approval_token TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
  receipt_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object'),
  source_evidence_id TEXT REFERENCES evidence(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  not_before INTEGER, submitted_at INTEGER, confirmed_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object')
) STRICT;
CREATE INDEX idx_actions_due ON actions(platform,status,not_before);
CREATE INDEX idx_actions_request ON actions(platform,request_digest,status);
CREATE TABLE assets (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'), byte_size INTEGER NOT NULL CHECK(byte_size>=0),
  media_type TEXT NOT NULL, created_at INTEGER NOT NULL, source_ref TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND json_type(manifest_json)='object'),
  CHECK(relative_path<>'' AND relative_path NOT LIKE '/%' AND relative_path NOT GLOB '[a-zA-Z]:*'
    AND instr(relative_path,char(92))=0 AND instr('/'||relative_path||'/','/../')=0 AND instr('/'||relative_path||'/','/./')=0)
) STRICT;
CREATE TABLE import_records (
  id TEXT PRIMARY KEY, source_key TEXT NOT NULL, source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
  source_type TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, status TEXT NOT NULL,
  field_map_json TEXT NOT NULL CHECK(json_valid(field_map_json) AND json_type(field_map_json)='object'),
  coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json) AND json_type(coverage_json)='object'),
  imported_at INTEGER NOT NULL, UNIQUE(source_key,source_digest,target_kind,target_id)
) STRICT;
CREATE INDEX idx_import_source ON import_records(source_key,source_digest);
CREATE TABLE cache_entries (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, schema_id TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version>0),
  value_json TEXT NOT NULL CHECK(json_valid(value_json) AND json_type(value_json)='object'),
  created_at INTEGER NOT NULL, expires_at INTEGER
) STRICT;
CREATE INDEX idx_cache_expiry ON cache_entries(expires_at);
CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT,'native evidence is immutable'); END;
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT,'native evidence is immutable'); END;
CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal_events BEGIN SELECT RAISE(ABORT,'native journal is immutable'); END;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal_events BEGIN SELECT RAISE(ABORT,'native journal is immutable'); END;
CREATE TRIGGER persona_versions_no_update BEFORE UPDATE ON persona_versions BEGIN SELECT RAISE(ABORT,'native persona version is immutable'); END;
CREATE TRIGGER persona_versions_no_delete BEFORE DELETE ON persona_versions BEGIN SELECT RAISE(ABORT,'native persona version is immutable'); END;
CREATE TRIGGER entity_short_ref_no_change BEFORE UPDATE OF short_ref ON entities
  WHEN OLD.short_ref IS NOT NULL AND (NEW.short_ref IS NULL OR NEW.short_ref<>OLD.short_ref)
  BEGIN SELECT RAISE(ABORT,'native entity short_ref is stable'); END;
`

export const NATIVE_TABLES = Object.freeze([
  'schema_meta','documents','persona_profiles','persona_versions','entities','platform_identities','memory_entries','evidence',
  'relations','journal_events','actions','assets','import_records','cache_entries',
])

const SCHEMA_HASH = createHash('sha256').update(NATIVE_DDL.replace(/\s+/g, ' ').trim()).digest('hex')
const TRIGGERS = ['evidence_no_update','evidence_no_delete','journal_no_update','journal_no_delete','persona_versions_no_update','persona_versions_no_delete','entity_short_ref_no_change']
const COLUMN_PROBES = Object.freeze({
  schema_meta: ['key','value'], documents: ['id','type','schema_id','schema_version','value_json','revision','created_at','updated_at'],
  persona_profiles: ['id','platform','follow_main','main_profile_id','name','self_ref','owner_address','body_md','traits_json','voice_json','revision','created_at','updated_at'],
  persona_versions: ['id','profile_id','version','name','self_ref','owner_address','body_md','traits_json','voice_json','follow_main','main_profile_id','reason','status','created_at'],
  entities: ['id','short_ref','kind','display_name','summary','metadata_json','created_at','updated_at'],
  platform_identities: ['id','namespace','platform_uid','entity_id','role','display_name','metadata_json','created_at','updated_at'],
  memory_entries: ['id','semantic_key','entity_key','level','entity_type','subject','actor_entity_id','actor_uid','predicate','object','content','title','keywords_json','project','goal','importance','corrected','subcategory','source_session_id','scope','visibility','platform','conversation_id','memory_type','status','reason','source_at','valid_from','valid_until','priority','heat','hit_count','created_at','updated_at','last_accessed_at'],
  evidence: ['id','dedupe_key','platform','conversation_id','actor_entity_id','actor_uid','direction','kind','text','ref','source_message_id','source_at','source_time_raw','recorded_at','status','confirmation','priority','visibility','source_type','source_json','receipt_json'],
  relations: ['id','subject_kind','subject_id','relation','object_kind','object_id','created_at','metadata_json'],
  journal_events: ['id','event_key','event_type','platform','entity_id','actor_uid','conversation_id','direction','status','visibility','text','ref','source_at','source_time_raw','source_type','recorded_at','metadata_json'],
  actions: ['id','platform','kind','target_json','body','body_digest','request_digest','approval_token','status','receipt_json','source_evidence_id','created_at','updated_at','not_before','submitted_at','confirmed_at','metadata_json'],
  assets: ['id','kind','relative_path','sha256','byte_size','media_type','created_at','source_ref','manifest_json'],
  import_records: ['id','source_key','source_digest','source_type','target_kind','target_id','status','field_map_json','coverage_json','imported_at'],
  cache_entries: ['key','kind','schema_id','schema_version','value_json','created_at','expires_at'],
})

function exists(file) { try { return fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
function safeFile(file, { createParent = false, writable = false } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || file !== path.resolve(file)) throw new Error('NativeStore文件必须是规范本地绝对路径')
  const parent = path.dirname(file), parsed = path.parse(file), components = parent.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let cursor = parsed.root
  for (const component of components) {
    cursor = path.join(cursor, component)
    let stat = exists(cursor)
    if (!stat) { if (!createParent) throw new Error('NativeStore父目录不存在'); fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor) }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('NativeStore目录不能通过符号链接或非目录访问')
  }
  const stat = exists(file)
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error('NativeStore文件必须是普通文件，不能是链接')
  for (const suffix of ['-wal','-shm','-journal']) if (exists(file + suffix)?.isSymbolicLink()) throw new Error('NativeStore事务文件不能是链接')
  if (writable) {
    const directory = fs.statSync(parent)
    if (directory.mode & 0o1000 || typeof process.getuid === 'function' && directory.uid !== process.getuid()) throw new Error('NativeStore需要调用者独有的私有父目录')
  }
  return stat
}

function validateNative(db) {
  try {
    if (db.prepare('PRAGMA application_id').get().application_id !== NATIVE_APPLICATION_ID
      || db.prepare('PRAGMA user_version').get().user_version !== NATIVE_SCHEMA_VERSION) throw new Error('native marker mismatch')
    const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM schema_meta').all().map(row => [row.key,row.value]))
    if (metadata.format !== NATIVE_FORMAT || metadata.schema_version !== String(NATIVE_SCHEMA_VERSION) || metadata.schema_fingerprint !== SCHEMA_HASH) throw new Error('native schema metadata mismatch')
    if (!/^(?:0|[1-9]\d{0,18})$/.test(metadata.person_ref_sequence || '')) throw new Error('native short reference registry mismatch')
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
    if (tables.join('\0') !== [...NATIVE_TABLES].sort().join('\0')) throw new Error('native table set mismatch')
    for (const [table, expected] of Object.entries(COLUMN_PROBES)) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
      if (columns.join('\0') !== expected.join('\0')) throw new Error('native columns mismatch')
    }
    const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' ORDER BY name").all().map(row => row.name)
    if (triggers.join('\0') !== [...TRIGGERS].sort().join('\0')) throw new Error('native immutable guards mismatch')
  } catch { throw new Error('该文件不是受支持的原生schema3数据库；未探测、读取或兼容旧格式内容') }
}

function text(value, name, { max = 4096, required = false, raw = false } = {}) {
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || required && !value.length || !raw && value.includes('\0')) throw new Error(name + '文本字段无效')
  return value
}
function id(value, label = 'id') { const result = text(value, label, { max: 160, required: true }); if (!/^[a-z][a-z0-9_.:/-]*$/.test(result)) throw new Error(label + '必须是稳定原生标识'); return result }
function shortRef(value) { if (typeof value !== 'string' || !/^p(?:0|[1-9]\d{0,18})$/.test(value)) throw new Error('short_ref必须是已登记的p序列标识'); return value }
function enumValue(value, values, label) { if (!values.includes(value)) throw new Error(label + '不在允许的取值中'); return value }
function time(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null
  let result = value
  if (typeof value === 'string') {
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
    if (!parts) throw new Error(label + '需包含时区的ISO时间或UTC毫秒')
    const [, y, mo, d, h, mi, s,,oh='0',om='0'] = parts
    const calendar = new Date(0); calendar.setUTCFullYear(Number(y), Number(mo)-1, Number(d)); calendar.setUTCHours(Number(h),Number(mi),Number(s),0)
    if (calendar.getUTCFullYear() !== Number(y) || calendar.getUTCMonth() !== Number(mo)-1 || calendar.getUTCDate() !== Number(d)
      || Number(h)>23 || Number(mi)>59 || Number(s)>59 || Number(oh)>23 || Number(om)>59) throw new Error(label + '来源日期无效')
    result = Date.parse(value)
  }
  if (!Number.isSafeInteger(result) || result < 0 || result > 8640000000000000) throw new Error(label + 'UTC时间无效')
  return result
}
function fields(input, allowed) { if (!isPlainObject(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('原生API包含未知字段'); return input }
function limit(value = 100) { if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error('limit必须为1至1000'); return value }

const documentRow = row => row ? { id: row.id, ...validateDocument({ type: row.type, schema_id: row.schema_id,
  schema_version: row.schema_version, value: JSON.parse(row.value_json) }), revision: row.revision, created_at: row.created_at, updated_at: row.updated_at } : null
const personaRow = row => {
  if (!row) return null
  const { traits_json, voice_json, ...rest } = row
  return { ...rest, follow_main: row.follow_main === 1, traits: JSON.parse(traits_json), voice: JSON.parse(voice_json) }
}
const entityRow = row => row ? { id: row.id, short_ref: row.short_ref, kind: row.kind, display_name: row.display_name, summary: row.summary,
  metadata: JSON.parse(row.metadata_json), created_at: row.created_at, updated_at: row.updated_at } : null
const identityRow = row => row ? { id: row.id, namespace: row.namespace, platform_uid: row.platform_uid,
  entity_id: row.entity_id, role: row.role, display_name: row.display_name, metadata: JSON.parse(row.metadata_json),
  created_at: row.created_at, updated_at: row.updated_at } : null
// Node's SQLite TEXT getter truncates embedded NUL although SQLite retained all
// bytes. Raw journal fields therefore use an explicit byte projection on reads.
const JOURNAL_SELECT = `SELECT journal_events.*,CAST(text AS BLOB) AS raw_text_bytes,
  CAST(ref AS BLOB) AS raw_ref_bytes,CAST(source_time_raw AS BLOB) AS raw_source_time_bytes FROM journal_events`
const rawString = (bytes, fallback) => bytes === undefined ? fallback : Buffer.from(bytes).toString('utf8')
const JOURNAL_VISIBILITIES = ['public','conversation','owner','secret']
const JOURNAL_STATUSES = ['recorded','confirmed','pending','unknown','failed','uncertain','draft','cancelled','expired','blocked','submitted','queued']
const journalRow = row => row ? { id: row.id, event_key: row.event_key, event_type: row.event_type, platform: row.platform,
  entity_id: row.entity_id, actor_uid: row.actor_uid, conversation_id: row.conversation_id, direction: row.direction,
  status: row.status, visibility: row.visibility, text: rawString(row.raw_text_bytes,row.text), ref: rawString(row.raw_ref_bytes,row.ref), source_at: row.source_at,
  source_time_raw: rawString(row.raw_source_time_bytes,row.source_time_raw),
  source_type: row.source_type, recorded_at: row.recorded_at, metadata: JSON.parse(row.metadata_json) } : null

/** Trusted host storage only. No model-facing write tool is exported or registered. */
const OPEN_NATIVE_STORES=new Map()
export function countOpenNativeStores(file){return OPEN_NATIVE_STORES.get(file)?.size??0}
export function hasOpenNativeStore(file){return countOpenNativeStores(file)>0}
export class NativeStore {
  constructor(options = {}) {
    fields(options, ['file','create','readOnly','now','busyTimeoutMs'])
    const { file, create = false, readOnly = false, now = Date.now, busyTimeoutMs = 5000 } = options
    if (typeof create !== 'boolean' || typeof readOnly !== 'boolean' || typeof now !== 'function'
      || !Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000 || create && readOnly) throw new Error('NativeStore打开选项无效')
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || file !== path.resolve(file)) throw new Error('NativeStore文件必须是规范本地绝对路径')
    const initial = exists(file)
    if (!initial && !create) throw new Error('NativeStore文件不存在；新建须显式create:true')
    safeFile(file, { createParent: create && !initial, writable: !readOnly })
    this.file = file; this.readOnly = readOnly; this.now = now; this.schemaVersion = NATIVE_SCHEMA_VERSION
    this.closed = false; this._depth = 0; this._savepoint = 0; this.created = false
    let madeFile = false, opened
    try {
      if (!initial) {
        const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd); madeFile = true; this.created = true
        opened = new DatabaseSync(file)
        this.db = opened
        opened.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA journal_mode=WAL;`)
        this.transaction(() => {
          opened.exec(NATIVE_DDL)
          const put = opened.prepare('INSERT INTO schema_meta(key,value) VALUES(?,?)')
          for (const [key, value] of Object.entries({ format: NATIVE_FORMAT, schema_version: String(NATIVE_SCHEMA_VERSION), schema_fingerprint: SCHEMA_HASH, person_ref_sequence: '0',
            created_at: String(this._now()) })) put.run(key, value)
          opened.exec(`PRAGMA application_id=${NATIVE_APPLICATION_ID}; PRAGMA user_version=${NATIVE_SCHEMA_VERSION};`)
        })
      } else {
        // Verify the native marker before any schema or permission mutation.
        const probe = new DatabaseSync(file, { readOnly: true })
        try { validateNative(probe) } finally { probe.close() }
        const next = safeFile(file, { writable: !readOnly })
        if (next.dev !== initial.dev || next.ino !== initial.ino) throw new Error('NativeStore文件在校验期间已变更')
        if (readOnly && ((next.mode & 0o777) !== 0o600 || (fs.statSync(path.dirname(file)).mode & 0o777) !== 0o700)) throw new Error('只读NativeStore要求既有文件0600及私有父目录0700，未修改权限')
        opened = new DatabaseSync(file, { readOnly })
        this.db = opened
        opened.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;`)
        if (readOnly) opened.exec('PRAGMA query_only=ON;')
        else opened.exec('PRAGMA journal_mode=WAL;')
      }
      validateNative(opened)
      if (!readOnly) { fs.chmodSync(path.dirname(file), 0o700); fs.chmodSync(file, 0o600) }
    } catch (error) {
      try { opened?.close() } catch {}
      this.closed = true
      if (madeFile) for (const suffix of ['-wal','-shm','-journal','']) { try { fs.unlinkSync(file + suffix) } catch {} }
      throw error
    }
    const handles=OPEN_NATIVE_STORES.get(file)??new Set();handles.add(this);OPEN_NATIVE_STORES.set(file,handles)
  }

  _now() { return time(this.now(), '存储时钟') }
  _open() { if (this.closed) throw new Error('NativeStore已关闭') }
  _write() { this._open(); if (this.readOnly) throw new Error('只读NativeStore不能写入') }
  close() { if (this.closed) return; if (this._depth) throw new Error('事务执行中不能关闭NativeStore'); this.db.close(); this.closed = true;const handles=OPEN_NATIVE_STORES.get(this.file);handles?.delete(this);if(!handles?.size)OPEN_NATIVE_STORES.delete(this.file) }

  transaction(callback) {
    this._open()
    if (typeof callback !== 'function') throw new Error('事务必须提供同步函数')
    const outer = this._depth === 0, savepoint = 'native_sp_' + (++this._savepoint)
    this.db.exec(outer ? this.readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    this._depth++
    try {
      const result = callback(this)
      if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); throw new Error('NativeStore事务只接受同步函数') }
      this.db.exec(outer ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (error) {
      if (outer) this.db.exec('ROLLBACK')
      else { this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); this.db.exec(`RELEASE SAVEPOINT ${savepoint}`) }
      throw error
    } finally { this._depth-- }
  }

  readSnapshot(callback) {
    this._open()
    if (typeof callback !== 'function') throw new Error('读取快照必须提供同步函数')
    const outer = this._depth === 0, savepoint = 'native_read_sp_' + (++this._savepoint)
    this.db.exec(outer ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
    this._depth++
    try {
      const result = callback(this)
      if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); throw new Error('读取快照只接受同步函数') }
      this.db.exec(outer ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (error) {
      if (outer) this.db.exec('ROLLBACK')
      else { this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); this.db.exec(`RELEASE SAVEPOINT ${savepoint}`) }
      throw error
    } finally { this._depth-- }
  }

  getDocument(documentId) {
    this._open(); id(documentId)
    return documentRow(this.db.prepare('SELECT * FROM documents WHERE id=?').get(documentId))
  }
  listDocuments(options = {}) {
    this._open(); fields(options, ['type','limit','after_id'])
    if (options.type !== undefined && !Object.hasOwn(DOCUMENT_CONTRACTS, options.type)) throw new Error('不支持的原生文档type')
    if (options.after_id !== undefined) id(options.after_id)
    const conditions = [], args = []
    if (options.type !== undefined) { conditions.push('type=?'); args.push(options.type) }
    if (options.after_id !== undefined) { conditions.push('id>?'); args.push(options.after_id) }
    return this.db.prepare('SELECT * FROM documents' + (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '') + ' ORDER BY id LIMIT ?')
      .all(...args, limit(options.limit)).map(documentRow)
  }
  putDocument(input) {
    this._write(); fields(input, ['id','type','schema_id','schema_version','value','expected_revision','created_at','updated_at'])
    const documentId = id(input.id), contract = validateDocument(input)
    if (input.expected_revision !== undefined && (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0)) throw new Error('expected_revision无效')
    return this.transaction(() => {
      const old = this.getDocument(documentId)
      if (input.expected_revision !== undefined && input.expected_revision !== (old?.revision || 0)) throw new Error('文档版本冲突')
      if (old && (old.type !== contract.type || old.schema_id !== contract.schema_id || old.schema_version !== contract.schema_version)) throw new Error('同一文档id不能改变契约类型')
      const createdAt = old?.created_at ?? (input.created_at === undefined ? this._now() : time(input.created_at, 'created_at'))
      if (old && input.created_at !== undefined && time(input.created_at, 'created_at') !== old.created_at) throw new Error('文档创建时间不可覆盖')
      const updatedAt = input.updated_at === undefined ? this._now() : time(input.updated_at, 'updated_at')
      this.db.prepare(`INSERT INTO documents(id,type,schema_id,schema_version,value_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(documentId, contract.type, contract.schema_id, contract.schema_version, stringifyJson(contract.value), (old?.revision || 0) + 1, createdAt, updatedAt)
      return this.getDocument(documentId)
    })
  }
  deleteDocument(documentId, options = {}) {
    this._write(); id(documentId); fields(options, ['expected_revision'])
    const { expected_revision } = options
    if (expected_revision !== undefined && (!Number.isSafeInteger(expected_revision) || expected_revision < 0)) throw new Error('expected_revision无效')
    return this.transaction(() => {
      const old = this.getDocument(documentId)
      if (expected_revision !== undefined && expected_revision !== (old?.revision || 0)) throw new Error('文档版本冲突')
      return { deleted: this.db.prepare('DELETE FROM documents WHERE id=?').run(documentId).changes > 0 }
    })
  }

  getPersonaProfile(profileId) { this._open(); id(profileId); return personaRow(this.db.prepare('SELECT * FROM persona_profiles WHERE id=?').get(profileId)) }
  listPersonaProfiles() { this._open(); return this.db.prepare('SELECT * FROM persona_profiles ORDER BY platform').all().map(personaRow) }
  putPersonaProfile(input) {
    this._write(); const next = validatePersona(input), profileId = id(next.id)
    return this.transaction(() => {
      const old = this.getPersonaProfile(profileId)
      if (next.expected_revision !== undefined && (!Number.isSafeInteger(next.expected_revision) || next.expected_revision !== (old?.revision || 0))) throw new Error('人设版本冲突')
      if (old && old.platform !== next.platform) throw new Error('人设id不能更换平台')
      const mainId = next.main_profile_id ?? null
      if (mainId !== null) {
        id(mainId, 'main_profile_id')
        if (mainId === profileId || this.getPersonaProfile(mainId)?.platform !== 'main') throw new Error('跟随目标必须是已存在的主人设')
      }
      const createdAt = old?.created_at ?? (next.created_at === undefined ? this._now() : time(next.created_at, 'created_at'))
      if (old && next.created_at !== undefined && time(next.created_at, 'created_at') !== old.created_at) throw new Error('人设创建时间不可覆盖')
      const updatedAt = next.updated_at === undefined ? this._now() : time(next.updated_at, 'updated_at')
      this.db.prepare(`INSERT INTO persona_profiles(id,platform,follow_main,main_profile_id,name,self_ref,owner_address,body_md,traits_json,voice_json,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET follow_main=excluded.follow_main,main_profile_id=excluded.main_profile_id,
        name=excluded.name,self_ref=excluded.self_ref,owner_address=excluded.owner_address,body_md=excluded.body_md,traits_json=excluded.traits_json,
        voice_json=excluded.voice_json,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(profileId, next.platform, next.follow_main ? 1 : 0, mainId, next.name, next.self_ref, next.owner_address, next.body_md,
          stringifyJson(next.traits), stringifyJson(next.voice), (old?.revision || 0) + 1, createdAt, updatedAt)
      return this.getPersonaProfile(profileId)
    })
  }
  putPersonaVersion(input) {
    this._write(); fields(input, ['id','profile_id','version','name','self_ref','owner_address','body_md','traits','voice','follow_main','main_profile_id','reason','status','created_at'])
    const profileId = id(input.profile_id)
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error('人设快照version无效')
    const versionId = input.id === undefined ? 'persona-version-' + createHash('sha256').update(profileId + '\0' + input.version).digest('hex').slice(0, 32) : id(input.id)
    return this.transaction(() => {
      const profile = this.getPersonaProfile(profileId)
      if (!profile) throw new Error('人设快照必须属于已存在的profile')
      const cooked = validatePersona({ id: profileId, platform: profile.platform, follow_main: input.follow_main,
        main_profile_id: input.main_profile_id, name: input.name, self_ref: input.self_ref, owner_address: input.owner_address,
        body_md: input.body_md, traits: input.traits, voice: input.voice })
      if (cooked.main_profile_id !== undefined && cooked.main_profile_id !== null && this.getPersonaProfile(id(cooked.main_profile_id))?.platform !== 'main') throw new Error('快照跟随目标必须是主人设')
      const old = this.getPersonaVersion(versionId)
      const row = { id: versionId, profile_id: profileId, version: input.version, name: cooked.name, self_ref: cooked.self_ref,
        owner_address: cooked.owner_address, body_md: cooked.body_md, traits: cooked.traits, voice: cooked.voice,
        follow_main: cooked.follow_main, main_profile_id: cooked.main_profile_id ?? null,
        reason: text(input.reason ?? '', 'reason', { max: 4000 }), status: enumValue(input.status ?? 'archived', ['active','archived'], 'status'),
        created_at: input.created_at === undefined ? old?.created_at ?? this._now() : time(input.created_at, 'created_at') }
      if (old) { if (!isDeepStrictEqual(old, row)) throw new Error('同一人设快照id出现不同内容，原快照保留'); return { ...old, duplicate: true } }
      this.db.prepare(`INSERT INTO persona_versions(id,profile_id,version,name,self_ref,owner_address,body_md,traits_json,voice_json,follow_main,main_profile_id,reason,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,row.profile_id,row.version,row.name,row.self_ref,row.owner_address,row.body_md,
          stringifyJson(row.traits),stringifyJson(row.voice),row.follow_main ? 1 : 0,row.main_profile_id,row.reason,row.status,row.created_at)
      return this.getPersonaVersion(versionId)
    })
  }
  getPersonaVersion(versionId) { this._open(); id(versionId); return personaRow(this.db.prepare('SELECT * FROM persona_versions WHERE id=?').get(versionId)) }
  listPersonaVersions(profileId, options = {}) {
    this._open(); id(profileId); fields(options, ['limit','before_version'])
    const args = [profileId], condition = options.before_version === undefined ? '' : ' AND version<?'
    if (options.before_version !== undefined) { if (!Number.isSafeInteger(options.before_version) || options.before_version < 1) throw new Error('before_version无效'); args.push(options.before_version) }
    return this.db.prepare('SELECT * FROM persona_versions WHERE profile_id=?' + condition + ' ORDER BY version DESC LIMIT ?').all(...args, limit(options.limit)).map(personaRow)
  }

  createEntity(input) {
    this._write(); fields(input, ['id','short_ref','kind','display_name','summary','metadata','created_at','updated_at'])
    const entityId = input.id === undefined ? 'entity-' + randomUUID() : id(input.id)
    const kind = enumValue(input.kind, ['person','account','self','topic','organization','source','object','place'], 'kind')
    const name = text(input.display_name ?? '', 'display_name', { max: 1000 }), summary = text(input.summary ?? '', 'summary', { max: 16000 })
    const metadata = validateJson(input.metadata ?? {}, { object: true })
    const createdAt = input.created_at === undefined ? this._now() : time(input.created_at, 'created_at'), updatedAt = input.updated_at === undefined ? createdAt : time(input.updated_at, 'updated_at')
    return this.transaction(() => {
      const ref = input.short_ref !== undefined && input.short_ref !== null ? this._reserveShortRef(input.short_ref) : kind === 'person' ? this._reserveShortRef() : null
      this.db.prepare('INSERT INTO entities(id,short_ref,kind,display_name,summary,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(entityId, ref, kind, name, summary, stringifyJson(metadata), createdAt, updatedAt)
      return this.getEntity(entityId)
    })
  }
  getEntity(entityId) { this._open(); id(entityId); return entityRow(this.db.prepare('SELECT * FROM entities WHERE id=?').get(entityId)) }
  getEntityByShortRef(reference) {
    this._open(); shortRef(reference)
    return entityRow(this.db.prepare('SELECT * FROM entities WHERE short_ref=?').get(reference))
  }
  _reserveShortRef(preferred) {
    // Caller holds the write transaction. The registry never decrements, even
    // when an entity is explicitly removed, so a published reference is not reused.
    const saved = this.db.prepare("SELECT value FROM schema_meta WHERE key='person_ref_sequence'").get()?.value
    if (!/^(?:0|[1-9]\d{0,18})$/.test(saved || '')) throw new Error('原生联系人序列登记损坏')
    let last = BigInt(saved)
    const maximum = this.db.prepare('SELECT short_ref FROM entities WHERE short_ref IS NOT NULL ORDER BY length(short_ref) DESC,short_ref DESC LIMIT 1').get()?.short_ref
    if (maximum && BigInt(maximum.slice(1)) > last) last = BigInt(maximum.slice(1))
    const reference = preferred === undefined ? 'p' + (last + 1n).toString() : shortRef(preferred)
    shortRef(reference)
    if (this.db.prepare('SELECT id FROM entities WHERE short_ref=?').get(reference)) throw new Error('short_ref已登记到另一个实体')
    const selected = BigInt(reference.slice(1))
    if (selected > last) last = selected
    this.db.prepare("UPDATE schema_meta SET value=? WHERE key='person_ref_sequence'").run(last.toString())
    return reference
  }
  assignShortRef(entityId, preferred) {
    this._write(); id(entityId)
    if (preferred !== undefined) shortRef(preferred)
    return this.transaction(() => {
      const entity = this.getEntity(entityId)
      if (!entity) throw new Error('实体不存在')
      if (entity.short_ref !== null) {
        if (preferred !== undefined && preferred !== entity.short_ref) throw new Error('已有short_ref不可改名或重新分配')
        return entity
      }
      const reference = this._reserveShortRef(preferred)
      this.db.prepare('UPDATE entities SET short_ref=?,updated_at=? WHERE id=?').run(reference,this._now(),entityId)
      return this.getEntity(entityId)
    })
  }
  updateEntity(entityId, patch) {
    this._write(); id(entityId); fields(patch, ['display_name','summary','metadata','updated_at'])
    return this.transaction(() => {
      const old = this.getEntity(entityId)
      if (!old) throw new Error('实体不存在')
      const next = { ...old, ...patch }
      text(next.display_name, 'display_name', { max: 1000 }); text(next.summary, 'summary', { max: 16000 })
      const metadata = validateJson(next.metadata, { object: true }), at = patch.updated_at === undefined ? this._now() : time(patch.updated_at, 'updated_at')
      this.db.prepare('UPDATE entities SET display_name=?,summary=?,metadata_json=?,updated_at=? WHERE id=?')
        .run(next.display_name,next.summary,stringifyJson(metadata),at,entityId)
      return this.getEntity(entityId)
    })
  }
  listEntities(options = {}) {
    this._open(); fields(options, ['kind','limit','after_id'])
    const conditions = [], args = []
    if (options.kind !== undefined) { enumValue(options.kind, ['person','account','self','topic','organization','source','object','place'], 'kind'); conditions.push('kind=?'); args.push(options.kind) }
    if (options.after_id !== undefined) { id(options.after_id); conditions.push('id>?'); args.push(options.after_id) }
    return this.db.prepare('SELECT * FROM entities' + (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '') + ' ORDER BY id LIMIT ?').all(...args, limit(options.limit)).map(entityRow)
  }
  deleteEntity(entityId) { this._write(); id(entityId); return { deleted: this.db.prepare('DELETE FROM entities WHERE id=?').run(entityId).changes > 0 } }
  getPlatformIdentity(namespace, platformUid) {
    this._open(); text(namespace, 'namespace', { max: 32, required: true }); text(platformUid, 'platform_uid', { max: 240, required: true })
    if (!/^[a-z][a-z0-9_-]*$/.test(namespace) || platformUid.trim() !== platformUid || !platformUid.trim()) throw new Error('namespace或platform_uid无效')
    return identityRow(this.db.prepare('SELECT * FROM platform_identities WHERE namespace=? AND platform_uid=?').get(namespace,platformUid))
  }
  listPlatformIdentities(options = {}) {
    this._open(); fields(options, ['namespace','entity_id','role','limit','after_id'])
    const conditions = [], args = []
    for (const key of ['namespace','entity_id','role','after_id']) if (options[key] !== undefined) {
      if (key === 'entity_id' || key === 'after_id') id(options[key])
      else if (key === 'role') enumValue(options[key], ['person','account','owner'], key)
      else if (typeof options[key] !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(options[key])) throw new Error('namespace无效')
      conditions.push((key === 'after_id' ? 'id>?' : key + '=?')); args.push(options[key])
    }
    return this.db.prepare('SELECT * FROM platform_identities' + (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '') + ' ORDER BY id LIMIT ?').all(...args, limit(options.limit)).map(identityRow)
  }
  upsertPlatformIdentity(input) {
    this._write(); fields(input, ['id','namespace','platform_uid','entity_id','role','display_name','metadata','created_at','updated_at'])
    const namespace = text(input.namespace, 'namespace', { max: 32, required: true }), uid = text(input.platform_uid, 'platform_uid', { max: 240, required: true })
    if (!/^[a-z][a-z0-9_-]*$/.test(namespace) || uid.trim() !== uid || !uid.trim()) throw new Error('namespace或platform_uid无效')
    return this.transaction(() => {
      const old = this.getPlatformIdentity(namespace, uid)
      if (old && input.entity_id !== undefined && id(input.entity_id) !== old.entity_id) throw new Error('稳定平台UID已属于另一个实体，不能按昵称或新请求合并')
      if (old && input.id !== undefined && id(input.id) !== old.id) throw new Error('稳定平台UID不能更换identity id')
      const role = enumValue(input.role ?? old?.role ?? 'person', ['person','account','owner'], 'role')
      const displayName = text(input.display_name ?? old?.display_name ?? '', 'display_name', { max: 1000 })
      const entity = old ? this.getEntity(old.entity_id) : input.entity_id === undefined
        ? this.createEntity({ kind: role === 'account' ? 'account' : 'person', display_name: displayName }) : this.getEntity(id(input.entity_id))
      if (!entity || (role === 'account' ? entity.kind !== 'account' : entity.kind !== 'person')) throw new Error('账号和人物身份必须链接到各自角色的实体')
      const identityId = old?.id ?? (input.id === undefined ? 'identity-' + randomUUID() : id(input.id))
      const metadata = validateJson(input.metadata ?? old?.metadata ?? {}, { object: true })
      const createdAt = old?.created_at ?? (input.created_at === undefined ? this._now() : time(input.created_at, 'created_at'))
      const updatedAt = input.updated_at === undefined ? this._now() : time(input.updated_at, 'updated_at')
      this.db.prepare(`INSERT INTO platform_identities(id,namespace,platform_uid,entity_id,role,display_name,metadata_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(namespace,platform_uid) DO UPDATE SET role=excluded.role,display_name=excluded.display_name,
        metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`).run(identityId,namespace,uid,entity.id,role,displayName,stringifyJson(metadata),createdAt,updatedAt)
      return this.getPlatformIdentity(namespace, uid)
    })
  }
  deletePlatformIdentity(namespace, platformUid) {
    this._write(); this.getPlatformIdentity(namespace,platformUid)
    return { deleted: this.db.prepare('DELETE FROM platform_identities WHERE namespace=? AND platform_uid=?').run(namespace,platformUid).changes > 0 }
  }

  appendJournalEvent(input) {
    this._write(); fields(input, ['id','event_key','event_type','platform','entity_id','actor_uid','conversation_id','direction','status','visibility','text','ref','source_at','source_time_raw','source_type','recorded_at','metadata'])
    if (!Object.hasOwn(input, 'source_at')) throw new Error('journal必须明确source_at；未知来源时间应传null')
    const eventKey = text(input.event_key, 'event_key', { max: 1024, required: true })
    const eventType = enumValue(input.event_type, ['interaction','experience','mood','log','diary','report','learning','notification','platform_read'], 'event_type')
    const platform = text(input.platform, 'platform', { max: 32, required: true })
    if (!/^[a-z][a-z0-9_-]*$/.test(platform)) throw new Error('platform无效')
    return this.transaction(() => {
      const old = journalRow(this.db.prepare(JOURNAL_SELECT + ' WHERE event_key=?').get(eventKey))
      const row = { id: input.id === undefined ? old?.id ?? 'journal-' + randomUUID() : id(input.id), event_key: eventKey, event_type: eventType, platform,
        entity_id: input.entity_id === undefined || input.entity_id === null ? null : id(input.entity_id),
        actor_uid: text(input.actor_uid ?? '', 'actor_uid', { max: 240 }), conversation_id: text(input.conversation_id ?? '', 'conversation_id', { max: 512 }),
        direction: enumValue(input.direction ?? 'observation', ['in','out','observation','state','internal'], 'direction'),
        status: enumValue(input.status ?? 'recorded', JOURNAL_STATUSES, 'status'),
        visibility: enumValue(input.visibility ?? 'owner', JOURNAL_VISIBILITIES, 'visibility'),
        text: text(input.text, 'text', { max: 2 * 1024 * 1024, raw: true }), ref: text(input.ref ?? '', 'ref', { max: 8192, raw: true }),
        source_at: time(input.source_at, 'source_at', { nullable: true }),
        source_time_raw: text(input.source_time_raw ?? (typeof input.source_at === 'string' ? input.source_at : ''), 'source_time_raw', { max: 1000, raw: true }),
        source_type: text(input.source_type, 'source_type', { max: 160, required: true }),
        recorded_at: input.recorded_at === undefined ? old?.recorded_at ?? this._now() : time(input.recorded_at, 'recorded_at'),
        metadata: validateJson(input.metadata ?? {}, { object: true, maxBytes: 2 * 1024 * 1024 }) }
      if (row.visibility === 'conversation' && !row.conversation_id.trim()) throw new Error('会话可见日志需明确非空conversation_id')
      if (old) { if (!isDeepStrictEqual(old,row)) throw new Error('同一journal event_key出现不同原始内容，原记录未覆盖'); return { ...old, duplicate: true } }
      this.db.prepare(`INSERT INTO journal_events(id,event_key,event_type,platform,entity_id,actor_uid,conversation_id,direction,status,visibility,text,ref,source_at,source_time_raw,source_type,recorded_at,metadata_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,row.event_key,row.event_type,row.platform,row.entity_id,row.actor_uid,row.conversation_id,row.direction,
          row.status,row.visibility,row.text,row.ref,row.source_at,row.source_time_raw,row.source_type,row.recorded_at,stringifyJson(row.metadata))
      return this.getJournalEvent(row.id)
    })
  }
  getJournalEvent(eventId) { this._open(); id(eventId); return journalRow(this.db.prepare(JOURNAL_SELECT + ' WHERE id=?').get(eventId)) }
  listJournalEvents(options = {}) {
    this._open(); fields(options, ['platform','entity_id','conversation_id','event_type','status','visibility','source_type','since','until','limit','cursor'])
    const conditions = [], args = []
    for (const key of ['platform','entity_id','conversation_id','event_type','status','visibility','source_type']) if (options[key] !== undefined) {
      if (key === 'entity_id') id(options[key]); else text(options[key], key, { max: 512, required: true })
      if (key === 'visibility') enumValue(options[key],JOURNAL_VISIBILITIES,key)
      if (key === 'status') enumValue(options[key],JOURNAL_STATUSES,key)
      conditions.push(key + '=?'); args.push(options[key])
    }
    if (options.since !== undefined) { conditions.push('source_at>=?'); args.push(time(options.since, 'since')) }
    if (options.until !== undefined) { conditions.push('source_at<=?'); args.push(time(options.until, 'until')) }
    if (options.cursor !== undefined) {
      fields(options.cursor, ['source_at','id']); id(options.cursor.id)
      const at = time(options.cursor.source_at, 'cursor.source_at', { nullable: true })
      if (at === null) { conditions.push('(source_at IS NULL AND id<?)'); args.push(options.cursor.id) }
      else { conditions.push('(source_at<? OR (source_at=? AND id<?) OR source_at IS NULL)'); args.push(at,at,options.cursor.id) }
    }
    return this.db.prepare(JOURNAL_SELECT + (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '')
      + ' ORDER BY source_at DESC,id DESC LIMIT ?').all(...args, limit(options.limit)).map(journalRow)
  }
}
