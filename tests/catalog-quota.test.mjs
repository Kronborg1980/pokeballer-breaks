import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { SiteHub } from '../worker.js';
import { hubState } from './support/hub-state.mjs';

function fixture() {
  const records = new Map([
    ['session:test', { user: 'admin' }],
    ['item:one', {id:'item:one',name:'First',type:'bundle',stock:4}],
    ['item:pack', {id:'item:pack',name:'Pack',type:'pack',stock:10,minBuy:1,maxBuy:4}]
  ]);
  const durable = new Map(), counts = {lists:0,reads:0};
  let liveStock = 8, listFailure = false;
  const env = {POKEBALLER_KV:{
    async list({prefix,cursor}) {
      counts.lists++;
      if(listFailure)throw new Error('KV list quota exceeded');
      const keys=[...records.keys()].filter(k=>k.startsWith(prefix));
      const index=Number(cursor||0);
      return {keys:keys.slice(index,index+1).map(name=>({name})),list_complete:index+1>=keys.length,cursor:String(index+1)};
    },
    async get(key,type){counts.reads++;const v=records.get(key);return v===undefined?null:type==='json'?structuredClone(v):JSON.stringify(v);},
    async put(key,value){records.set(key,JSON.parse(value));},
    async delete(key){records.delete(key);}
  },ORDER_DESK:{idFromName:id=>id,get:()=>({async fetch(_url,options){
    const body=JSON.parse(options.body);
    if(body.op==='sync')liveStock=body.stock;
    return Response.json(body.op==='state'?{stock:liveStock,limits:{minBuy:1,maxBuy:4}}:{ok:true});
  }})}};
  let hub;
  function restart(){hub=new SiteHub(hubState(durable),env);}
  restart();
  env.SITE_HUB={idFromName:n=>n,get:()=>({fetch:(url,options)=>hub.fetch(new Request(url,options))})};
  async function request(method='GET',id='',body){
    return worker.fetch(new Request('https://test.local/api/items'+(id?'/'+id:''),{
      method,headers:{Authorization:'Bearer test','Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    }),env,{});
  }
  return {records,durable,counts,env,request,restart,setStock:n=>liveStock=n,failLists:()=>listFailure=true};
}

test('concurrent visitors scan all pages once, then reuse content while pack stock stays live',async()=>{
  const f=fixture();
  const results=await Promise.all(Array.from({length:20},()=>f.request()));
  assert.ok(results.every(r=>r.status===200));
  assert.equal(f.counts.lists,2);assert.equal(f.counts.reads,2);
  assert.equal((await results[0].json()).find(i=>i.id==='item:pack').stock,8);
  f.setStock(3);f.failLists();
  const next=await f.request();
  assert.equal((await next.json()).find(i=>i.id==='item:pack').stock,3);
  assert.equal(f.counts.lists,2);assert.equal(f.counts.reads,2);
});

test('persisted index survives eviction even if KV listing is no longer available',async()=>{
  const f=fixture();await f.request();f.restart();f.failLists();
  const response=await f.request();assert.equal(response.status,200);
  assert.equal((await response.json()).length,2);assert.equal(f.counts.lists,2);
});

test('authenticated create, edit and delete keep the warm catalogue current without rescanning',async()=>{
  const f=fixture();await f.request();f.failLists();
  const created=await f.request('POST','',{name:'New',type:'pack',stock:5,images:[]});
  assert.equal(created.status,200);const {item}=await created.json();
  assert.ok((await (await f.request()).json()).some(i=>i.id===item.id));
  assert.equal((await f.request('PUT',item.id,{name:'Edited',stock:2,hidden:true,images:[]})).status,200);
  const updated=(await (await f.request()).json()).find(i=>i.id===item.id);
  assert.equal(updated.name,'Edited');assert.equal(updated.hidden,true);assert.equal(updated.stock,2);
  // Only the rare purchase-archive cleanup still lists KV on item deletion.
  f.env.POKEBALLER_KV.list=async()=>({keys:[],list_complete:true});
  assert.equal((await f.request('DELETE',item.id,{})).status,200);
  assert.ok(!(await (await f.request()).json()).some(i=>i.id===item.id));
  f.restart();assert.ok(!(await (await f.request()).json()).some(i=>i.id===item.id));
});

test('failed bootstrap never persists a partial index',async()=>{
  const f=fixture();let calls=0;
  const list=f.env.POKEBALLER_KV.list;
  f.env.POKEBALLER_KV.list=async options=>{if(++calls===2)throw new Error('migration interrupted');return list(options);};
  assert.equal((await f.request()).status,500);
  assert.equal(f.durable.has('catalog:ids'),false);
  f.env.POKEBALLER_KV.list=list;
  assert.equal((await f.request()).status,200);
  assert.equal((await (await f.request()).json()).length,2);
});

test('content refresh after five minutes reuses the index and never lists again',async()=>{
  const f=fixture();const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
  try {
    await f.request();f.failLists();clock+=300001;
    assert.equal((await f.request()).status,200);
    assert.equal(f.counts.lists,2);assert.equal(f.counts.reads,4);
  }finally{Date.now=realNow;}
});

test('an empty migrated catalogue does not scan KV again',async()=>{
  const f=fixture();f.records.delete('item:one');f.records.delete('item:pack');
  assert.deepEqual(await (await f.request()).json(),[]);f.restart();f.failLists();
  assert.deepEqual(await (await f.request()).json(),[]);assert.equal(f.counts.lists,1);
});

test('admin edits stay visible while KV reads still return the pre-edit version',async()=>{
  for(const warm of [false,true]){
    const f=fixture();const originalGet=f.env.POKEBALLER_KV.get;
    const original=structuredClone(f.records.get('item:one'));
    const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
    try{
      if(warm)await f.request();
      clock+=299999;
      assert.equal((await f.request('PUT','item:one',{name:'Immediate',stock:2,images:[]})).status,200);
      f.env.POKEBALLER_KV.get=async(key,type)=>key==='item:one'&&type==='json'?structuredClone(original):originalGet(key,type);
      clock+=1000;
      const result=await (await f.request()).json();
      assert.equal(result.find(i=>i.id==='item:one').name,'Immediate');
      assert.equal(result.find(i=>i.id==='item:one').stock,2);
    }finally{Date.now=realNow;}
  }
});
