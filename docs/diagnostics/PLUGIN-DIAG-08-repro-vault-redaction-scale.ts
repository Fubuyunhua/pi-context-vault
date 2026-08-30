import { performance } from "node:perf_hooks";
import { redactSecrets } from "../../src/artifacts/redaction.ts";
const rows=[];
for(const bytes of [1024,16*1024,64*1024,128*1024,256*1024]){const input="x".repeat(bytes);const start=performance.now();const result=redactSecrets(input);rows.push({shape:"single-line",bytes,durationMs:Number((performance.now()-start).toFixed(2)),redactionCount:result.redactionCount,unchanged:result.content===input});}
const wrapped=("x".repeat(1023)+"\n").repeat(256);const wrappedStart=performance.now();const wrappedResult=redactSecrets(wrapped);rows.push({shape:"1KB-lines",bytes:Buffer.byteLength(wrapped),durationMs:Number((performance.now()-wrappedStart).toFixed(2)),redactionCount:wrappedResult.redactionCount,unchanged:wrappedResult.content===wrapped});
const ratios=rows.filter(row=>row.shape==="single-line").slice(1).map((row,index)=>({fromBytes:rows[index].bytes,toBytes:row.bytes,sizeRatio:row.bytes/rows[index].bytes,durationRatio:Number((row.durationMs/rows[index].durationMs).toFixed(2))}));
const output={generatedAt:new Date().toISOString(),runtime:`Bun ${Bun.version}`,rows,ratios,reproduced:rows.at(-2)!.durationMs>30000&&rows.at(-1)!.durationMs<rows.at(-2)!.durationMs/10};console.log(JSON.stringify(output,null,2));if(!output.reproduced)process.exitCode=1;
