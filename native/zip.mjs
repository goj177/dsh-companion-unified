/** Standard ZIP (stored/deflate, UTF-8, regular files only). Pure bytes, no paths or filesystem authority. */
import {deflateRawSync,inflateRawSync} from 'node:zlib'
export const ZIP_LIMITS=Object.freeze({max_total_bytes:512*1024*1024,max_file_bytes:256*1024*1024,max_entries:20000,max_archive_bytes:544*1024*1024})
const fail=()=>new Error('原生资料ZIP路径、类型、容量或完整性校验失败')
const table=new Uint32Array(256)
for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0}
export function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0}
export function safeZipName(name){
  if(typeof name!=='string'||!name||name.length>1024||!name.isWellFormed()||/[\\\0-\x1f\x7f:]/.test(name)||name.startsWith('/')||name.endsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..'||part.trim()!==part||part.endsWith('.')))throw fail()
  return name
}
const bytesOf=value=>Buffer.isBuffer(value)||value instanceof Uint8Array?Buffer.from(value):(()=>{throw fail()})()
export function makeNativeZip(input,limits=ZIP_LIMITS){
  const entries=input instanceof Map?[...input]:input
  if(!Array.isArray(entries)||entries.length>limits.max_entries||entries.length>65534)throw fail()
  const locals=[],central=[],names=new Set();let offset=0,total=0
  for(const [name,value]of entries){const bytes=bytesOf(value),label=Buffer.from(safeZipName(name)),folded=name.normalize('NFC').toLowerCase();if(names.has(folded)||label.length>65535)throw fail();names.add(folded);total+=bytes.length;if(bytes.length>limits.max_file_bytes||total>limits.max_total_bytes)throw fail()
    const compressed=deflateRawSync(bytes),crc=crc32(bytes),local=Buffer.alloc(30),record=Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(label.length,26)
    record.writeUInt32LE(0x02014b50);record.writeUInt16LE(0x314,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(8,10);record.writeUInt32LE(crc,16);record.writeUInt32LE(compressed.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(label.length,28);record.writeUInt32LE((0o100600<<16)>>>0,38);record.writeUInt32LE(offset,42)
    locals.push(local,label,compressed);central.push(record,label);offset+=local.length+label.length+compressed.length;if(offset>0xfffffffe)throw fail()
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16)
  const result=Buffer.concat([...locals,directory,end]);if(result.length>limits.max_archive_bytes)throw fail();return result
}
export function readNativeZip(input,limits=ZIP_LIMITS){
  const buffer=bytesOf(input);if(buffer.length<22||buffer.length>limits.max_archive_bytes)throw fail();let end=-1
  for(let p=buffer.length-22;p>=Math.max(0,buffer.length-65557);p--)if(buffer.readUInt32LE(p)===0x06054b50){end=p;break}
  if(end<0||buffer.readUInt16LE(end+4)||buffer.readUInt16LE(end+6)||buffer.readUInt16LE(end+8)!==buffer.readUInt16LE(end+10))throw fail()
  const count=buffer.readUInt16LE(end+10),directorySize=buffer.readUInt32LE(end+12),directoryOffset=buffer.readUInt32LE(end+16)
  if(count>limits.max_entries||count===65535||directoryOffset+directorySize!==end||end+22+buffer.readUInt16LE(end+20)!==buffer.length)throw fail()
  const files=new Map(),occupied=[],names=new Set();let cursor=directoryOffset,total=0
  for(let i=0;i<count;i++){
    if(cursor+46>end||buffer.readUInt32LE(cursor)!==0x02014b50)throw fail()
    const flags=buffer.readUInt16LE(cursor+8),method=buffer.readUInt16LE(cursor+10),crc=buffer.readUInt32LE(cursor+16),compressed=buffer.readUInt32LE(cursor+20),size=buffer.readUInt32LE(cursor+24),nameSize=buffer.readUInt16LE(cursor+28),extra=buffer.readUInt16LE(cursor+30),comment=buffer.readUInt16LE(cursor+32),mode=buffer.readUInt32LE(cursor+38)>>>16,offset=buffer.readUInt32LE(cursor+42)
    if(flags!==0x800||![0,8].includes(method)||mode&&((mode&0xf000)!==0x8000)||buffer.readUInt16LE(cursor+34)||extra||comment||cursor+46+nameSize>end)throw fail()
    const label=buffer.subarray(cursor+46,cursor+46+nameSize),name=safeZipName(label.toString('utf8')),folded=name.normalize('NFC').toLowerCase();if(!Buffer.from(name).equals(label)||names.has(folded))throw fail();names.add(folded);total+=size
    if(size>limits.max_file_bytes||total>limits.max_total_bytes||offset+30>directoryOffset||buffer.readUInt32LE(offset)!==0x04034b50)throw fail()
    const localNameSize=buffer.readUInt16LE(offset+26),localExtra=buffer.readUInt16LE(offset+28),start=offset+30+localNameSize+localExtra,finish=start+compressed
    if(localExtra||offset+30+localNameSize>directoryOffset||!buffer.subarray(offset+30,offset+30+localNameSize).equals(label)||buffer.readUInt16LE(offset+6)!==flags||buffer.readUInt16LE(offset+8)!==method||buffer.readUInt32LE(offset+14)!==crc||buffer.readUInt32LE(offset+18)!==compressed||buffer.readUInt32LE(offset+22)!==size||finish>directoryOffset||occupied.some(([a,b])=>offset<b&&finish>a))throw fail()
    occupied.push([offset,finish]);const payload=buffer.subarray(start,finish);let bytes
    try{bytes=method===8?inflateRawSync(payload,{maxOutputLength:Math.max(1,Math.min(size,limits.max_file_bytes))}):Buffer.from(payload)}catch{throw fail()}
    if(bytes.length!==size||crc32(bytes)!==crc)throw fail();files.set(name,bytes);cursor+=46+nameSize
  }
  if(cursor!==end)throw fail()
  occupied.sort((a,b)=>a[0]-b[0]);let position=0;for(const[start,finish]of occupied){if(start!==position)throw fail();position=finish}if(position!==directoryOffset)throw fail()
  return files
}
