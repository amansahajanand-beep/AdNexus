require('dotenv').config();
const svc=require('./src/services/roiService');
const {mergeRoiParts}=require('./src/services/roiMerge');
(async()=>{
const A='4fdaaf6a-d82d-4734-a4d4-766cababe483';
const nets=['661e799c-8d7a-4060-b935-69bb71e475a1','defe2f58-93b4-498b-9290-967bf34e14e2'];
const f=x=>Math.round(x*100)/100, sm=(l,k='earn')=>f((l||[]).reduce((a,x)=>a+x[k],0));
const parts=[];
for (const id of nets) parts.push(await svc.getRoiSummary(id,{start:'2026-10-12',end:'2026-10-18',accountIds:[A],appKeys:['com.chats.textmessages'],siteKeys:['__none__'],targetType:'all',viewTz:'America/Los_Angeles',crossNetworkEarn:true,breakdownOnly:true,includeDaily:true}));
const m=mergeRoiParts(parts);
console.log('R merged', sm(m.countryTargetBreakdown), sm(m.countryTargetDailyBreakdown), sm(m.countryBreakdown), 'rows',m.countryTargetBreakdown.length,m.countryTargetDailyBreakdown.length);
// single network with earn (adyntra alone)
const s=await svc.getRoiSummary(nets[0],{start:'2026-10-12',end:'2026-10-18',accountIds:[A],viewTz:'America/Los_Angeles',breakdownOnly:true,includeDaily:true});
console.log('R single', sm(s.countryTargetBreakdown), sm(s.countryTargetDailyBreakdown), sm(s.countryBreakdown), s.countryTargetBreakdown.length);
process.exit(0)})();
