import fs from 'node:fs';
const BASE = process.env.PANEL_BASE || 'http://127.0.0.1:3081';
const r = await fetch(BASE + '/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({username:'admin',password:process.argv[2]}) });
const cookie = (r.headers.getSetCookie?.()||[]).map(c=>c.split(';')[0]).join('; ');
const pid = fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).find(p=>{
  try { return fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes('server.js') && fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes('node'); } catch(e){ return false; }
});
const fds = () => fs.readdirSync('/proc/'+pid+'/fd').length;
const socks = () => fs.readdirSync('/proc/'+pid+'/fd').filter(f=>{ try { return fs.readlinkSync('/proc/'+pid+'/fd/'+f).startsWith('socket:'); } catch(e){ return false; } }).length;

const base = { fd: fds(), sock: socks() };
console.log(`基线:            fd=${base.fd} socket=${base.sock}`);

// 20 个并发 SSE
const acs = [];
for (let i=0;i<20;i++){ const ac=new AbortController(); acs.push(ac);
  fetch(BASE+'/api/stream',{headers:{Cookie:cookie},signal:ac.signal}).then(res=>{ const rd=res.body.getReader(); rd.read().catch(()=>{}); }).catch(()=>{}); }
await new Promise(r=>setTimeout(r,3000));
const open = { fd: fds(), sock: socks() };
console.log(`20个SSE连接后:   fd=${open.fd} socket=${open.sock}  (+${open.sock-base.sock})`);

// 全部断开
acs.forEach(a=>a.abort());
for (const w of [2000, 5000, 8000]) {
  await new Promise(r=>setTimeout(r, w===2000?2000:w-2000));
  const cur = { fd: fds(), sock: socks() };
  console.log(`断开后 ${w/1000}s:      fd=${cur.fd} socket=${cur.sock}  (残留 ${cur.sock-base.sock})`);
}

const fin = { fd: fds(), sock: socks() };
const leak = fin.sock - base.sock;
console.log('');
console.log(leak <= 1 ? `✅ SSE 无泄漏（残留 ${leak} 个 socket，基线 ${base.sock}）` : `❌ 泄漏 ${leak} 个 socket`);

// 第二轮：验证多次连接不累积
for (let round=0; round<3; round++) {
  const t=[];
  for (let i=0;i<10;i++){ const ac=new AbortController(); t.push(ac);
    fetch(BASE+'/api/stream',{headers:{Cookie:cookie},signal:ac.signal}).then(res=>res.body.getReader().read().catch(()=>{})).catch(()=>{}); }
  await new Promise(r=>setTimeout(r,1500));
  t.forEach(a=>a.abort());
  await new Promise(r=>setTimeout(r,2500));
  console.log(`第 ${round+1} 轮 10 连接后: fd=${fds()} socket=${socks()}`);
}
const last = { sock: socks() };
console.log('');
console.log(last.sock - base.sock <= 1 ? `✅ 多轮连接无累积泄漏（最终 socket=${last.sock}）` : `❌ 累积泄漏 ${last.sock-base.sock} 个`);
process.exit(leak <= 1 ? 0 : 1);
