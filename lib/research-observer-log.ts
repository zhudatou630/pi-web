import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isPathWithinRoots } from "./path-security";
import { researchRunPattern } from "./research-observer";

export async function readResearchLogTail(home: string, runId: string, relative: string, limit = 384*1024) {
  if (!researchRunPattern.test(runId) || !/^logs\/[A-Za-z0-9_.-]+\.(out|err)$/.test(relative)) throw new Error("Invalid research log");
  const runs = await realpath(resolve(home,"data/runs"));
  const root = await realpath(resolve(runs,runId));
  const logs = await realpath(resolve(root,"logs"));
  const file = await realpath(resolve(root,relative));
  if (!isPathWithinRoots(root,new Set([runs])) || !isPathWithinRoots(logs,new Set([root])) || !isPathWithinRoots(file,new Set([logs]))) throw new Error("Research log escapes run root");
  const handle = await open(file,"r");
  try {
    const stat=await handle.stat();const start=Math.max(0,stat.size-limit);const buffer=Buffer.alloc(Math.min(limit,stat.size));
    const {bytesRead}=await handle.read(buffer,0,buffer.length,start);let body=buffer.subarray(0,bytesRead);let offset=start;
    if (start) {const newline=body.indexOf(10);if(newline<0)return {text:"",offset:stat.size,truncated:true};offset+=newline+1;body=body.subarray(newline+1);}
    // A record still being written is retried on the next poll.
    const end=body.lastIndexOf(10);if(end<0)return {text:"",offset,truncated:start>0};
    return {text:body.subarray(0,end+1).toString("utf8"),offset,truncated:start>0};
  } finally {await handle.close();}
}
