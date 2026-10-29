import fs from 'node:fs';
const BASE='http://127.0.0.1:3081';
const pid = fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).find(p=>{
  try { const c=fs.readFileSync('/proc/'+p+'/cmdline','utf8'); return c.includes('server.js')&&c.includes('node'); } catch(e){ return false; }
});
const rss = () => +(new RegExp('^VmRSS:\\s*(\\d+)','m').exec(fs.readFileSync('/proc/'+pid+'/status','utf8'))[1])/1024;
const lr = await fetch(BASE+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.argv[2]})});
const cookie=(lr.headers.getSetCookie?.()||[]).map(c=>c.split(';')[0]).join('; ');
const eps=['/api/system','/api/metrics/latest','/api/processes/summary','/api/ports','/api/sensors','/api/boot','/api/connections?limit=20','/api/inodes','/api/timesync','/api/docker/status'];

console.log('=== 4 轮 × 200 请求，观察内存是否线性增长 ===');
for (let round=1; round<=4; round++) {
  for (let i=0;i<200;i++) { try { await fetch(BASE+eps[i%eps.length],{headers:{Cookie:cookie}}); } catch(e){} }
  await new Promise(r=>setTimeout(r,2000));
  console.log(`  第 ${round} 轮后: RSS=${rss().toFixed(1)}MB`);
}
await new Promise(r=>setTimeout(r,4000));
console.log(`  等待 4s 后:  RSS=${rss().toFixed(1)}MB`);
