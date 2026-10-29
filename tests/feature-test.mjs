const BASE = process.env.PANEL_BASE || 'http://127.0.0.1:3081';
const PASSWORD = process.argv[2];
const r=await fetch(BASE+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password: PASSWORD})});
const cookie=(r.headers.getSetCookie?.()||[]).map(c=>c.split(';')[0]).join('; ');
const csrf=(await r.json()).csrf;
const H={'Content-Type':'application/json',Cookie:cookie};
const Hc={...H,'X-CSRF-Token':csrf};
const get=async p=>{const res=await fetch(BASE+p,{headers:H});return {status:res.status, body:await res.json().catch(()=>null)}};
const post=async(p,b)=>{const res=await fetch(BASE+p,{method:'POST',headers:Hc,body:JSON.stringify(b)});return {status:res.status, body:await res.json().catch(()=>null)}};

let pass=0,fail=0;
const t=(n,ok,d)=>{console.log(`${ok?'✅':'❌'} ${n}${d?' — '+d:''}`);ok?pass++:fail++};

// === 文件管理 ===
console.log('\n=== 文件管理 ===');
let r1 = await get('/api/files/list?path=/');
t('目录列表', r1.body.ok && r1.body.entries.length>0, `${r1.body.entries?.length} 项, ${r1.body.usage? (r1.body.usage.used/1e9).toFixed(1)+'GB 已用':''}`);

r1 = await get('/api/files/list?path=' + encodeURIComponent(process.env.HOME || '/'));
t('子目录', r1.body.ok, r1.body.path);

r1 = await get('/api/files/read?path=/etc/hostname');
t('读取文件', r1.body.ok && r1.body.content, JSON.stringify(r1.body.content?.trim()));

r1 = await post('/api/files/write',{path:'/tmp/panel-test-write.txt', content:'测试内容 test\n'});
t('写入文件', r1.body.ok, r1.body.size+'B');

r1 = await get('/api/files/read?path=/tmp/panel-test-write.txt');
t('回读验证', r1.body.content==='测试内容 test\n', JSON.stringify(r1.body.content));

r1 = await post('/api/files/mkdir',{path:'/tmp/panel-test-dir'});
t('新建目录', r1.body.ok);

r1 = await post('/api/files/rename',{from:'/tmp/panel-test-write.txt', to:'/tmp/panel-test-dir/renamed.txt'});
t('移动文件', r1.body.ok);

r1 = await post('/api/files/chmod',{path:'/tmp/panel-test-dir/renamed.txt', mode:0o600});
t('修改权限', r1.body.ok && r1.body.mode==='rw-------', r1.body.mode);

r1 = await post('/api/files/compress',{sources:['/tmp/panel-test-dir'], dest:'/tmp/panel-test.tar.gz', cwd:'/tmp'});
t('压缩', r1.body.ok, r1.body.size+'B');

r1 = await post('/api/files/extract',{archive:'/tmp/panel-test.tar.gz', dest:'/tmp/panel-test-extract'});
t('解压', r1.body.ok);

r1 = await post('/api/files/delete',{path:'/tmp/panel-test-dir'});
t('删除目录', r1.body.ok);

// 路径穿越
r1 = await get('/api/files/list?path=../../etc');
t('路径穿越防护', r1.body.ok && r1.body.path==='/etc', '解析为 '+r1.body.path);

// === 压测 ===
console.log('\n=== 性能压测 ===');
r1 = await get('/api/bench/status');
t('压测状态', r1.body.ok && r1.body.running===false, '未运行');

r1 = await post('/api/bench/start',{kind:'cpu', threads:2, durationSec:3});
t('启动 CPU 压测', r1.body.ok, r1.body.started);

await new Promise(r=>setTimeout(r,1500));
r1 = await get('/api/bench/status');
t('运行中状态', r1.body.running===true, `${r1.body.kind} 已运行 ${Math.round(r1.body.elapsedMs/1000)}s`);

await new Promise(r=>setTimeout(r,3000));
r1 = await get('/api/bench/status');
t('压测完成', r1.body.running===false && r1.body.lastResult, 
  r1.body.lastResult ? `评分 ${r1.body.lastResult.score}, 峰值温度 ${r1.body.lastResult.temp?.max}°C` : '');

r1 = await get('/api/bench/history');
t('历史结果', r1.body.ok && r1.body.results.length>0, `${r1.body.results.length} 条记录`);

// 中止测试
r1 = await post('/api/bench/start',{kind:'cpu', threads:2, durationSec:30});
await new Promise(r=>setTimeout(r,800));
r1 = await post('/api/bench/abort',{});
t('中止压测', r1.body.ok);

// === 终端 ===
console.log('\n=== Web 终端 ===');
r1 = await post('/api/terminal/create',{cols:100, rows:30});
t('创建终端', r1.body.ok && r1.body.id, `ID ${r1.body.id?.slice(0,8)}…`);
const termId = r1.body.id;

if (termId) {
  // 订阅输出流
  const ac = new AbortController();
  const sseRes = await fetch(`${BASE}/api/terminal/stream?id=${termId}`, {headers:{Cookie:cookie}, signal:ac.signal});
  t('终端流连接', sseRes.status===200, sseRes.headers.get('content-type'));

  const reader = sseRes.body.getReader();
  const dec = new TextDecoder();
  let out='';
  // 单一后台读取循环，避免并发 read
  let reading = true;
  const pumpLoop = (async () => {
    try { while (reading) { const {value,done}=await reader.read(); if(done) break; out += dec.decode(value,{stream:true}); } } catch(e){}
  })();
  const readSome = (ms) => new Promise(r=>setTimeout(r,ms));
  await readSome(1000);

  await post('/api/terminal/input',{id:termId, data:'echo TERM_OK_$((6*7))\n'});
  await readSome(1200);
  t('终端执行命令', out.includes('TERM_OK_42'), '捕获输出含 TERM_OK_42');

  r1 = await post('/api/terminal/resize',{id:termId, cols:120, rows:40});
  t('调整尺寸', r1.body.ok, `${r1.body.cols}x${r1.body.rows}`);

  reading = false;
  ac.abort();
  r1 = await post('/api/terminal/close',{id:termId});
  t('关闭终端', r1.body.ok);
}

// 清理残留
try {
  const fs = await import('node:fs');
  for (const f of ['/tmp/panel-test-write.txt','/tmp/panel-test.tar.gz']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  for (const d of ['/tmp/panel-test-dir','/tmp/panel-test-extract']) {
    try { fs.rmSync(d, {recursive:true, force:true}); } catch (e) {}
  }
} catch (e) {}

console.log(`\n${pass}/${pass+fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
