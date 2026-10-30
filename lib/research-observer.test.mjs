import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,mkdir,writeFile,rm,symlink,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,sep,basename} from "node:path";
import {fileURLToPath} from "node:url";
import {createJiti} from "jiti";
const jiti=createJiti(import.meta.url,{alias:{"@":fileURLToPath(new URL("../",import.meta.url))}});
const {parseResearchLog,researchSelection,sanitizeResearchValue}=await jiti.import("./research-observer.ts");
const {readResearchLogTail}=await jiti.import("./research-observer-log.ts");
const route=await jiti.import("../app/api/research/observer/[runId]/route.ts");
const id="00000000-0000-4000-8000-000000000002";

async function temporary(t){
  const root=await mkdtemp(join(tmpdir(),"research-observer-unit-"));
  t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));assert.ok(basename(root).startsWith("research-observer-unit-"));await rm(root,{recursive:true,force:true});});
  return root;
}
test("observer shows actual assistant/tools but omits reasoning, init settings and image bytes",()=>{
  const trace=[
    {type:"system",subtype:"init",private_settings:"unit-only-private"},
    {type:"assistant",message:{model:"claude-sonnet-5-5",content:[{type:"thinking",thinking:"unit-only-hidden-reasoning"},{type:"text",text:"Inspecting the actual source"},{type:"tool_use",name:"Bash",input:{command:"python real_script.py",api_key:"unit-only-key-value"}}]}},
    {type:"user",message:{content:[{type:"tool_result",content:[{type:"text",text:"actual tool result; Bearer unit-only-credential"},{type:"image",data:"unit-only-base64-image"}]}]}},
    {type:"result",subtype:"success",result:"Completed actual step"}
  ].map(x=>JSON.stringify(x)).join("\n");
  const records=parseResearchLog(trace,"logs/1000-claude.out");const body=JSON.stringify(records);
  assert.ok(body.includes("python real_script.py") && body.includes("actual tool result"));
  for(const hidden of ["unit-only-private","unit-only-hidden-reasoning","unit-only-key-value","unit-only-base64-image","unit-only-credential"])assert.ok(!body.includes(hidden),hidden);
  assert.deepEqual(records.map(r=>r.kind),["assistant","tool","output","assistant"]);
  assert.equal(new Set(records.map(r=>r.id)).size,records.length);
});
test("malformed or still-partial stream records cannot break the observer",()=>{
  assert.doesNotThrow(()=>parseResearchLog('{"type":"assistant","message":{"content":{}}}\n{"type":"assistant","message":{"content":[null,{"type":"tool_use"}]}}\n{"unfinished":',"logs/1000-claude.out"));
  assert.equal(researchSelection("../../service.json"),null);assert.equal(researchSelection("latest"),"latest");assert.equal(researchSelection(id),id);
  assert.equal(JSON.stringify(sanitizeResearchValue({message:"unit-private-token",password:"unit-secret"},"unit-private-token")).includes("unit-private-token"),false);
  const dated=parseResearchLog(JSON.stringify({type:"result",result:"unit dated result",timestamp:"2026-10-28T10:00:00Z"}),"logs/1000-claude.out");
  assert.equal(dated[0].recorded_at,Date.parse("2026-10-28T10:00:00Z")/1000);
  assert.equal(parseResearchLog(JSON.stringify({type:"result",result:"unit undated result"}),"logs/1000-claude.out")[0].recorded_at,undefined);
});
test("bounded reads keep complete real records and preserve stable byte offsets",async t=>{
  const root=await temporary(t);const logs=join(root,"data/runs",id,"logs");await mkdir(logs,{recursive:true});
  const prefix="old ignored bytes\n".repeat(100);const complete=JSON.stringify({type:"result",result:"真实中文结果"})+"\n";const partial='{"still_writing":';
  await writeFile(join(logs,"1000-claude.out"),prefix+complete+partial);
  const tail=await readResearchLogTail(root,id,"logs/1000-claude.out",200);
  assert.ok(tail.truncated);assert.ok(!tail.text.includes(partial));const records=parseResearchLog(tail.text,"logs/1000-claude.out",tail.offset);
  assert.equal(records.at(-1).text,"真实中文结果");assert.equal(records.at(-1).id,`logs/1000-claude.out:${Buffer.byteLength(prefix)}`);
  await assert.rejects(()=>readResearchLogTail(root,id,"logs/../service.json"),/Invalid/);
});
test("log reader rejects a symlink outside the run, even with an allowed log filename",async t=>{
  const root=await temporary(t);const outside=await temporary(t);const logs=join(root,"data/runs",id,"logs");await mkdir(logs,{recursive:true});
  await writeFile(join(outside,"1000-claude.out"),"unit-only-outside\n");
  await symlink(outside,join(logs,"escaped"),process.platform==="win32"?"junction":"dir");
  await assert.rejects(()=>readResearchLogTail(root,id,"logs/escaped/1000-claude.out"),/Invalid/);
  // A junction for the entire logs directory must also be rejected.
  const other="00000000-0000-4000-8000-000000000003";await mkdir(join(root,"data/runs",other),{recursive:true});
  await symlink(outside,join(root,"data/runs",other,"logs"),process.platform==="win32"?"junction":"dir");
  await assert.rejects(()=>readResearchLogTail(root,other,"logs/1000-claude.out"),/escapes/);
});
test("GET-only route reads existing state, filters paths and never returns the private worker token",async t=>{
  const root=await temporary(t);const oldHome=process.env.RESEARCH_LOOP_HOME;process.env.RESEARCH_LOOP_HOME=root;
  const oldFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=oldFetch;if(oldHome===undefined)delete process.env.RESEARCH_LOOP_HOME;else process.env.RESEARCH_LOOP_HOME=oldHome;});
  const token="unit-only-private-service-token-1234567890";await mkdir(join(root,"data/runs",id,"logs"),{recursive:true});await writeFile(join(root,"data/service.json"),JSON.stringify({port:30145,token}));
  const path="logs/1000-claude.out";await writeFile(join(root,"data/runs",id,path),JSON.stringify({type:"assistant",message:{content:[{type:"text",text:`actual unit record ${token}`} ]}})+"\n");
  let calls=0;globalThis.fetch=async(url,options)=>{calls++;assert.equal(String(url),`http://127.0.0.1:30145/v1/runs/${id}`);assert.equal(options.headers.Authorization,`Bearer ${token}`);assert.ok(!options.method || options.method==="GET");return Response.json({id,title:"unit-only existing job",status:"running",stage:"planning",round:1,config:{max_rounds:5},events:[],artifacts:[{path,size:300},{path:"../service.json",size:999}],active_log:path});};
  const response=await route.GET(new Request("http://localhost/"),{params:Promise.resolve({runId:id})});assert.equal(response.status,200);const text=await response.text();const body=JSON.parse(text);
  assert.equal(body.read_only,true);assert.equal(body.records.length,1);assert.ok(!text.includes(token));assert.equal(calls,1);assert.equal(route.POST,undefined);
  assert.deepEqual(body.artifacts.map(item=>item.path),[path]);
  const invalid=await route.GET(new Request("http://localhost/"),{params:Promise.resolve({runId:"invalid"})});assert.equal(invalid.status,400);assert.equal(calls,1);
  assert.equal(await readFile(join(root,"data/runs",id,path),"utf8"),JSON.stringify({type:"assistant",message:{content:[{type:"text",text:`actual unit record ${token}`} ]}})+"\n");
});
