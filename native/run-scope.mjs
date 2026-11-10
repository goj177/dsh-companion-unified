import {AsyncLocalStorage} from 'node:async_hooks'

// Runtime controls stay outside tool arguments and persisted/model context.
// Async work keeps its original scope even after its task has timed out.
const runs=new AsyncLocalStorage()
export const currentRunScope=()=>runs.getStore()
export function withRunScope(scope,work){
  if(typeof work!=='function')throw new Error('活动执行需要可信回调')
  if(!scope)return work()
  const bound={signal:scope.signal,deadline_at:scope.deadline_at,now:scope.now??Date.now,assert_active:scope.assert_active,mark_started:scope.mark_started}
  return runs.run(bound,()=>{assertRunActive(bound);return work()})
}
export function assertRunActive(scope=currentRunScope()){
  if(!scope)return
  if(scope.signal?.aborted)throw scope.signal.reason instanceof Error?scope.signal.reason:new Error('活动已取消或超时，未继续执行')
  if(Number.isSafeInteger(scope.deadline_at)&&scope.now()>=scope.deadline_at)throw new Error('活动执行期限已结束，未继续执行')
  scope.assert_active?.()
}
export function abortableRun(work,scope=currentRunScope()){
  // Always observe abandoned work: an uncooperative provider may reject later.
  const pending=Promise.resolve(work);pending.catch(()=>{})
  try{assertRunActive(scope)}catch(error){return Promise.reject(error)}
  if(!scope?.signal)return pending
  return new Promise((resolve,reject)=>{
    const done=(settle,value)=>{scope.signal.removeEventListener('abort',abort);settle(value)}
    const abort=()=>done(reject,scope.signal.reason instanceof Error?scope.signal.reason:new Error('活动已取消或超时，未继续执行'))
    scope.signal.addEventListener('abort',abort,{once:true})
    if(scope.signal.aborted){abort();return}
    pending.then(value=>done(resolve,value),error=>done(reject,error))
  })
}
