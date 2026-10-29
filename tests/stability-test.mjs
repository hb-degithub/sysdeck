import fs from 'node:fs';
const BASE = 'http://127.0.0.1:3081';
const pid = fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).find(p=>{
  try { const c=fs.readFileSync('/proc/'+p+'/cmdline','utf8'); return c.includes('server.js')&&c.includes('node'); } catch(e){ return false; }
});
const stat = () => {
  const s = fs.readFileSync('/proc/'+pid+'/status','utf8');
  const g = k => (new RegExp('^'+k+':\\s*(\\d+)','m').exec(s)||[])[1];
  return { rss: +g('VmRSS')/1024, threads: +g('Threads'), fds: fs.readdirSync('/proc/'+pid+'/fd').length };
};
const rssNow = () => stat();

console.log('=== 内存/线程/FD 稳定性（每 3 秒采样，共 15 秒）===');
const samples = [];
for (let i=0;i<6;i++){
  const s = rssNow();
  samples.push(s);
  console.log(`  t=${i*3}s  RSS=${s.rss.toFixed(1)}MB  线程=${s.threads}  FD=${s.fds}`);
  if (i<5) await new Promise(r=>setTimeout(r,3000));
}
const first = samples[0], last = samples[samples.length-1];
const growth = last.rss - first.rss;
console.log('');
console.log(Math.abs(growth) < 15 ? `✅ 内存稳定（变化 ${growth>0?'+':''}${growth.toFixed(1)}MB）` : `⚠️ 内存增长 ${growth.toFixed(1)}MB`);
console.log(last.threads <= first.threads + 2 ? `✅ 线程数稳定（${first.threads} → ${last.threads}）` : `⚠️ 线程增长 ${first.threads} → ${last.threads}`);
console.log(last.fds <= first.fds + 5 ? `✅ FD 稳定（${first.fds} → ${last.fds}）` : `⚠️ FD 增长 ${first.fds} → ${last.fds}`);

// 会话表压力测试：连续登录 30 次，验证会话不无限增长（有 TTL 清理）
console.log('\n=== 会话管理压力测试 ===');
const before = stat();
for (let i=0;i<30;i++){
  await fetch(BASE+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.argv[2]})});
}
await new Promise(r=>setTimeout(r,1500));
const after = stat();
console.log(`  30 次登录后: RSS ${before.rss.toFixed(1)} → ${after.rss.toFixed(1)}MB, FD ${before.fds} → ${after.fds}`);
console.log(after.rss - before.rss < 20 ? '✅ 会话创建无明显内存膨胀' : `⚠️ 内存增加 ${(after.rss-before.rss).toFixed(1)}MB`);

// 接口连续调用压力：200 次混合请求
console.log('\n=== 接口压力测试（200 次混合请求）===');
const lr = await fetch(BASE+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.argv[2]})});
const cookie = (lr.headers.getSetCookie?.()||[]).map(c=>c.split(';')[0]).join('; ');
const eps = ['/api/system','/api/metrics/latest','/api/processes/summary','/api/ports','/api/sensors','/api/boot','/api/connections?limit=20','/api/inodes','/api/timesync','/api/docker/status'];
const t0 = Date.now();
let ok=0, fail=0; const times=[];
for (let i=0;i<200;i++){
  const ep = eps[i % eps.length];
  const s = Date.now();
  try { const r = await fetch(BASE+ep,{headers:{Cookie:cookie}}); if(r.ok) ok++; else fail++; } catch(e){ fail++; }
  times.push(Date.now()-s);
}
const total = Date.now()-t0;
times.sort((a,b)=>a-b);
console.log(`  成功 ${ok}/${ok+fail}, 总耗时 ${total}ms, 平均 ${(total/200).toFixed(1)}ms/请求`);
console.log(`  延迟 P50=${times[100]}ms P95=${times[190]}ms P99=${times[198]}ms 最大=${times[199]}ms`);
console.log(fail === 0 ? '✅ 200 次请求全部成功' : `❌ ${fail} 次失败`);
const final = stat();
console.log(`\n压测后: RSS=${final.rss.toFixed(1)}MB 线程=${final.threads} FD=${final.fds}`);
console.log(final.rss - first.rss < 25 ? '✅ 整体内存健康' : `⚠️ 相对初始增长 ${(final.rss-first.rss).toFixed(1)}MB`);
