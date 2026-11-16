/** Offline composition of one corroborated expert root and the reliability roots. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureByHash, planSchema } from "./crm022-reliability.mjs";

const root = resolve(import.meta.dirname,"../..");
const local = resolve(root,".local/crm022");
const serial = value => JSON.stringify(value,null,2)+"\n";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const check = (ok, message) => { if(!ok) throw new Error(message); };

async function fixedFile(input, digest) {
  check(typeof input === "string" && hash.test(digest??""),"crm022_telemetry_fixed_evidence_required");
  const absolute = await realpath(resolve(root,input));
  const boundary = await realpath(local);
  check(absolute.startsWith(boundary+sep),"crm022_telemetry_evidence_outside_batch");
  const bytes = await readFile(absolute);
  check(sha(bytes)===digest,"crm022_telemetry_evidence_digest_changed");
  return { path:relative(root,absolute).replaceAll("\\","/"),sha256:digest,data:JSON.parse(bytes) };
}

async function seal(path,data) {
  const bytes=serial(data);
  await writeFile(path,bytes,{flag:"wx",mode:0o600});
  return {path,sha256:sha(bytes)};
}

async function prepare([batchId,fixtureHash,calibrationPath,calibrationHash,autoRootId,...faultPairs]) {
  check(uuid.test(batchId??"")&&hash.test(fixtureHash??"")&&uuid.test(autoRootId??"")&&faultPairs.length<=4&&faultPairs.length%2===0,
    "crm022_telemetry_plan_arguments_invalid");
  const directory=resolve(local,"reliability",batchId);
  const fixture=await fixtureByHash(directory,fixtureHash);
  const head=execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8",windowsHide:true}).trim();
  check(fixture.id===batchId&&fixture.head===head,"crm022_telemetry_source_changed");
  const calibration=await fixedFile(calibrationPath,calibrationHash);
  check((calibration.data.data?.run_id??calibration.data.runId)===autoRootId,"crm022_telemetry_auto_run_receipt_mismatch");
  const runs=[{runId:autoRootId,source:{path:calibration.path,sha256:calibration.sha256},kind:"expert_calibration",expectedChildren:3}];
  for(let i=0;i<faultPairs.length;i+=2) {
    const fault=await fixedFile(faultPairs[i],faultPairs[i+1]);
    const {runId,scenario,after}=fault.data;
    check(fault.path.startsWith(relative(root,directory).replaceAll("\\","/")+"/")&&
      ["retry","interrupt"].includes(scenario)&&uuid.test(runId??"")&&after?.job?.status==="done",
    "crm022_telemetry_reliability_report_required");
    runs.push({runId,source:{path:fault.path,sha256:fault.sha256},kind:scenario,expectedChildren:0});
  }
  check(new Set(runs.map(row=>row.runId)).size===runs.length,"crm022_telemetry_unique_roots_required");
  const locked=await seal(resolve(directory,"trace-cohort-index.json"),{version:1,batchId,fixtureHash,head,runs,preparedAt:new Date().toISOString()});
  const sourceHashes=JSON.parse(execFileSync(process.execPath,[resolve(import.meta.dirname,"crm022-reliability.mjs"),"source-manifest"],
    {cwd:root,encoding:"utf8",windowsHide:true,timeout:10000}));
  const plan=planSchema.parse({version:1,batchId,head,fixtureHash,organizationId:fixture.organizationId,
    organizationSlug:fixture.organizationSlug,database:fixture.database,cases:[],telemetryRootIds:runs.map(row=>row.runId),
    langfuseOrigin:"http://127.0.0.1:3006",sourceHashes,evidence:[{name:"trace-cohort-index.json",sha256:locked.sha256}]});
  console.log(JSON.stringify({...await seal(resolve(directory,"plan-delivery-cohort.json"),plan),cohortHash:locked.sha256,
    roots:runs.map(({runId,expectedChildren})=>({runId,expectedChildren})),requests:0}));
}

async function verify([cohortPath,cohortHash,afterPath,afterHash]) {
  const [expected,report]=await Promise.all([fixedFile(cohortPath,cohortHash),fixedFile(afterPath,afterHash)]);
  check(report.data.scenario==="delivery-after"&&Array.isArray(report.data.runs)&&report.data.runs.length===expected.data.runs.length,
    "crm022_telemetry_exact_report_required");
  const roots=expected.data.runs.map(row=>{
    const actual=report.data.runs.find(value=>value.runId===row.runId);
    const children=actual?.roots.filter(value=>value.parent_run_id===row.runId&&value.run_kind==="specialist");
    const rootSpan=actual?.remote.observations?.find(span=>span.name==="crm.run"&&span.parentObservationId===null);
    const childSpans=actual?.remote.observations?.filter(span=>span.name==="crm.specialist"&&span.parentObservationId===rootSpan?.id);
    const countPass=children?.length===row.expectedChildren&&childSpans?.length===row.expectedChildren;
    return {runId:row.runId,expectedChildren:row.expectedChildren,sqlChildren:children?.length??null,remoteChildren:childSpans?.length??null,
      expectedSpans:actual?.expectedStableIds.length??null,observedSpans:actual?.remote.observationCount??null,
      parentGraphVerified:countPass&&actual?.sqlParentCoverage===true&&!!rootSpan,complete:actual?.complete??false};
  });
  const pass=report.data.status==="pass"&&roots.every(row=>row.parentGraphVerified&&row.complete);
  console.log(JSON.stringify({pass,roots,reportSha256:report.sha256,cohortSha256:expected.sha256,requests:0}));
  if(!pass) process.exitCode=1;
}

async function main([mode,...args]) {
  if(mode==="prepare") return prepare(args);
  if(mode==="verify"&&args.length===4) return verify(args);
  console.log("prepare <batchId> <fixtureSha> <autoReceipt> <autoReceiptSha> <autoRootId> [<faultReport> <faultSha> ...]; verify <cohortIndex> <indexSha> <deliveryAfterReport> <reportSha>");
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error=>{console.error(/^crm022_[a-z_]+$/.test(error.message??"")?error.message:"crm022_telemetry_plan_failed");process.exitCode=1;});
