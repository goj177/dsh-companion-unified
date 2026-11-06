import {isDeepStrictEqual} from 'node:util'
import {isPlainObject} from './contracts.mjs'

const locationDependent=node=>isPlainObject(node)?Object.entries(node).some(([key,value])=>['$id','$ref','$anchor','id'].includes(key)||locationDependent(value)):Array.isArray(node)&&node.some(locationDependent)

/** Factor only constraints already imposed by the common, single-platform
 * object root. No references, new vocabulary, executor or capability change. */
export function compactNativeReadParameters(schema){
  const properties=schema?.properties,platform=properties?.platform
  if(schema?.type!=='object'||schema.additionalProperties!==false||!isPlainObject(properties)||!Array.isArray(schema.anyOf)||!Array.isArray(schema.required)||platform?.type!=='string'||platform.enum?.length!==1||!['tieba','bilibili'].includes(platform.enum[0]))return schema
  const keys=Object.keys(properties).sort(),known=new Set(['type','properties','required','additionalProperties'])
  if(schema.anyOf.some(branch=>!isPlainObject(branch)||Object.keys(branch).some(key=>!known.has(key))||branch.type!=='object'||branch.additionalProperties!==false||!isPlainObject(branch.properties)||!isDeepStrictEqual(Object.keys(branch.properties).sort(),keys)||!Array.isArray(branch.required)||!isDeepStrictEqual(branch.properties.platform,platform)))return schema
  const branches=schema.anyOf.map(branch=>{
    const selected={...branch.properties};delete selected.platform
    for(const key of ['operation','args'])if(isPlainObject(selected[key])&&selected[key].type===properties[key]?.type){selected[key]={...selected[key]};delete selected[key].type;if(Array.isArray(selected[key].required)&&selected[key].required.length===0)delete selected[key].required}
    const required=branch.required.filter(key=>!schema.required.includes(key))
    return {properties:selected,...(required.length?{required}:{})}
  })
  const factored={...schema,anyOf:branches},args=properties.args,types={}
  // The same field type need only appear once. Each operation still declares
  // its allowed keys locally, so additionalProperties:false keeps its meaning.
  if(!isPlainObject(args)||Object.keys(args).some(key=>key!=='type'))return factored
  for(const branch of branches){
    const fields=branch.properties.args
    if(!isPlainObject(fields)||!isPlainObject(fields.properties)||Object.keys(fields).some(key=>!['properties','required','additionalProperties'].includes(key)))return factored
    for(const[key,value]of Object.entries(fields.properties)){
      if(locationDependent(value)||Object.hasOwn(types,key)&&!isDeepStrictEqual(types[key],value))return factored
      types[key]=value
    }
  }
  const promoted={...factored,properties:{...properties,args:{...args,properties:types}},anyOf:branches.map(branch=>({...branch,properties:{...branch.properties,args:{...branch.properties.args,properties:Object.fromEntries(Object.keys(branch.properties.args.properties).map(key=>[key,{}]))}}}))}
  return JSON.stringify(promoted).length<JSON.stringify(factored).length?promoted:factored
}
