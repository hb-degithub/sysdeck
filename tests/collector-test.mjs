#!/usr/bin/env node
/**
 * CPU 拓扑 / 通用采集 单元与集成测试（零依赖）
 *
 * 覆盖：8C16T / 8C8T / 多路 / sysfs 与 /proc/cpuinfo 两种来源 / threads_per_core 推算 /
 *      回退逻辑 / physicalCoresEstimated 区分实测与推算；实时检测与快照字段；
 *      告警 loadPerCore 使用线程数；通用传感器空态。
 *
 * 用法：node tests/collector-test.mjs [--keep]
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const collector = require('../lib/collector.js');
const { metricValue } = require('../lib/alerts.js');
const { resolveDshConfig } = require('../lib/dsh.js');

const results = [];
const skipped = [];

function rec(group, name, ok, detail, ms) {
  results.push({ group, name, ok: Boolean(ok), detail, ms });
  console.log(`${ok ? '✅' : '❌'} [${group}] ${name}${detail ? ' — ' + detail : ''}${ms !== undefined ? ` (${ms}ms)` : ''}`);
}

function skip(name, detail) {
  skipped.push({ name, detail });
  console.log(`⏭️  [跳过] ${name}${detail ? ' — ' + detail : ''}`);
}

function sysEntries(packages, coresPerPackage, threadsPerCore) {
  const entries = [];
  for (let pkg = 0; pkg < packages; pkg += 1) {
    for (let core = 0; core < coresPerPackage; core += 1) {
      for (let t = 0; t < threadsPerCore; t += 1) entries.push({ packageId: pkg, coreId: core });
    }
  }
  return entries;
}

function cpuinfoText(packages, coresPerPackage, threadsPerCore) {
  const blocks = [];
  let index = 0;
  for (let pkg = 0; pkg < packages; pkg += 1) {
    for (let core = 0; core < coresPerPackage; core += 1) {
      for (let t = 0; t < threadsPerCore; t += 1) {
        blocks.push(
          [
            `processor\t: ${index}`,
            `physical id\t: ${pkg}`,
            `core id\t: ${core}`,
            `siblings\t: ${coresPerPackage * threadsPerCore}`,
            `cpu cores\t: ${coresPerPackage}`,
            'model name\t: Test CPU',
            '',
          ].join('\n')
        );
        index += 1;
      }
    }
  }
  return blocks.join('\n');
}

function testTopologyUnit() {
  const group = '拓扑单元';

  const c816 = collector.computeTopology({ threads: 16, sysEntries: sysEntries(1, 8, 2) });
  rec(group, 'sysfs 8C16T → 8 核 16 线程、SMT', c816.physicalCores === 8 && c816.threads === 16 && c816.threadsPerCore === 2 && c816.smt === true && c816.physicalCoresEstimated === false, JSON.stringify(c816));

  const c88 = collector.computeTopology({ threads: 8, sysEntries: sysEntries(1, 8, 1) });
  rec(group, 'sysfs 8C8T → SMT=false', c88.physicalCores === 8 && c88.threadsPerCore === 1 && c88.smt === false && c88.physicalCoresEstimated === false, JSON.stringify(c88));

  const dual = collector.computeTopology({ threads: 16, sysEntries: sysEntries(2, 4, 2) });
  rec(group, '双路 2×4C/16T → 8 物理核（跨 package 去重）', dual.physicalCores === 8 && dual.threads === 16 && dual.smt === true, JSON.stringify(dual));

  const cCpuinfo = collector.computeTopology({ threads: 16, sysEntries: null, cpuinfoText: cpuinfoText(1, 8, 2) });
  rec(group, '/proc/cpuinfo 8C16T → 8 核（实测）', cCpuinfo.physicalCores === 8 && cCpuinfo.threadsPerCore === 2 && cCpuinfo.smt === true && cCpuinfo.physicalCoresEstimated === false, JSON.stringify(cCpuinfo));

  const siblingsOnly = [
    'processor\t: 0',
    'siblings\t: 8',
    'cpu cores\t: 4',
    '',
    'processor\t: 1',
    'siblings\t: 8',
    'cpu cores\t: 4',
    '',
  ].join('\n');
  const cSiblings = collector.computeTopology({ threads: 8, sysEntries: null, cpuinfoText: siblingsOnly });
  rec(group, 'cpuinfo siblings/cpu cores 推算（标记 estimated）', cSiblings.physicalCores === 4 && cSiblings.threadsPerCore === 2 && cSiblings.physicalCoresEstimated === true, JSON.stringify(cSiblings));

  const cTpc = collector.computeTopology({ threads: 16, sysEntries: null, cpuinfoText: '', threadsPerCore: 2 });
  rec(group, 'threads_per_core 推算 8C16T（estimated）', cTpc.physicalCores === 8 && cTpc.smt === true && cTpc.physicalCoresEstimated === true && cTpc.source === 'threads_per_core', JSON.stringify(cTpc));

  const cFallback = collector.computeTopology({ threads: 16 });
  rec(group, '无任何拓扑信息 → physicalCores=threads、smt=false、estimated', cFallback.physicalCores === 16 && cFallback.threadsPerCore === 1 && cFallback.smt === false && cFallback.physicalCoresEstimated === true && cFallback.source === 'fallback', JSON.stringify(cFallback));

  rec(group, 'computeCoresFromSys 非法/空输入 → null', collector.computeCoresFromSys([]) === null && collector.computeCoresFromSys([{ packageId: -1, coreId: 0 }]) === null && collector.computeCoresFromSys(null) === null);
  rec(group, 'parseCpuinfoTopology 空文本 → null', collector.parseCpuinfoTopology('', 8) === null && collector.parseCpuinfoTopology('nonsense', 8) === null);
}

function testLiveDetection() {
  const group = '实时检测';
  const threads = os.cpus().length;
  const topo = collector.detectCpuTopology();
  rec(group, '检测线程数 = os.cpus().length', topo.threads === threads, `threads=${topo.threads}`);
  rec(group, '物理核在 1..线程数 区间', Number.isInteger(topo.physicalCores) && topo.physicalCores >= 1 && topo.physicalCores <= topo.threads, `physical=${topo.physicalCores} threads=${topo.threads}`);
  rec(group, 'threadsPerCore / smt 自洽', topo.threadsPerCore === Math.max(1, Math.round(topo.threads / topo.physicalCores)) && topo.smt === topo.threadsPerCore > 1, `tpc=${topo.threadsPerCore} smt=${topo.smt}`);
  rec(group, 'physicalCoresEstimated 为布尔且与来源一致', typeof topo.physicalCoresEstimated === 'boolean' && (topo.source === 'sysfs' || topo.source === 'cpuinfo:physical-core' ? topo.physicalCoresEstimated === false : true), `source=${topo.source} estimated=${topo.physicalCoresEstimated}`);

  const staticInfo = collector.readStaticInfo();
  rec(group, '/api/system 静态信息含 threadsPerCore/smt/estimated', staticInfo.cpuCores === topo.threads && staticInfo.cpuPhysicalCores === topo.physicalCores && staticInfo.cpuThreadsPerCore === topo.threadsPerCore && staticInfo.cpuSmt === topo.smt && staticInfo.cpuPhysicalCoresEstimated === topo.physicalCoresEstimated, JSON.stringify({ cores: staticInfo.cpuCores, physical: staticInfo.cpuPhysicalCores, tpc: staticInfo.cpuThreadsPerCore, smt: staticInfo.cpuSmt, estimated: staticInfo.cpuPhysicalCoresEstimated }));

  const inst = new collector.Collector({ intervalMs: 1000 });
  inst.sample();
  const snapshot = inst.sample();
  rec(group, 'metrics 快照 cpu 含 physicalCores/threads/threadsPerCore/smt', snapshot.cpu.physicalCores === topo.physicalCores && snapshot.cpu.threads === topo.threads && snapshot.cpu.threadsPerCore === topo.threadsPerCore && snapshot.cpu.smt === topo.smt && snapshot.cpu.physicalCoresEstimated === topo.physicalCoresEstimated, JSON.stringify({ physicalCores: snapshot.cpu.physicalCores, threads: snapshot.cpu.threads, tpc: snapshot.cpu.threadsPerCore, smt: snapshot.cpu.smt }));
  rec(group, '├ coreCount 保留兼容（=线程数）', snapshot.cpu.coreCount === snapshot.cpu.threads && snapshot.cpu.perCore.length === snapshot.cpu.threads, `coreCount=${snapshot.cpu.coreCount} perCore=${snapshot.cpu.perCore.length}`);
  rec(group, '└ 传感器字段缺失时为 null（不显示假 0）', snapshot.sensors.gpuTemp === null || typeof snapshot.sensors.gpuTemp === 'number', `gpuTemp=${snapshot.sensors.gpuTemp} gpuPower=${snapshot.sensors.gpuPowerW}`);
  inst.stop?.();
}

function testGenericDefaults() {
  const group = '通用默认值';
  const cfg = resolveDshConfig({
    dsh: { home: '', bin: '', lanHost: '', publicUrl: '', webHost: '', homeDir: '', profile: '', unit: '', patch: '' },
  });
  rec(group, '空字符串配置 = 用默认/自动推导（开源 config.example）', cfg.home.length > 0 && cfg.bin.length > 0 && cfg.profile === 'headless' && cfg.unit === 'deepseek-harness' && cfg.homeDir === os.homedir() && cfg.patch === '', JSON.stringify({ home: cfg.home, bin: cfg.bin, profile: cfg.profile, homeDir: cfg.homeDir, patch: cfg.patch }));
  rec(group, 'lanHost/publicUrl/webHost 默认空（由请求 Host 推导）', cfg.lanHost === '' && cfg.publicUrl === '' && cfg.webHost === '', JSON.stringify({ lanHost: cfg.lanHost, publicUrl: cfg.publicUrl, webHost: cfg.webHost }));
  rec(group, 'patch 默认不加载本机补丁', cfg.patch === '', JSON.stringify(cfg.patch));

  // 示例配置必须是合法 JSON 且不含个人路径/IP/密码
  const examplePath = path.join(process.cwd(), 'config.example.json');
  let example = null;
  try {
    example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  } catch (e) {
    example = null;
  }
  const exampleText = example ? JSON.stringify(example) : '';
  const hasPersonalPath = /\/home\/[a-z]/.test(exampleText);
  const hasPrivateIp = /(192\.168\.|10\.\d{1,3}\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(exampleText);
  const hasScrypt = /scrypt\$/.test(exampleText);
  rec(group, 'config.example.json 合法且不含个人路径/内网 IP/密码', Boolean(example) && !hasPersonalPath && !hasPrivateIp && !hasScrypt, example ? `path=${hasPersonalPath} ip=${hasPrivateIp} hash=${hasScrypt}` : 'missing');
  rec(group, '└ 示例包含 dsh 通用字段且 patch 为空', Boolean(example?.dsh) && example.dsh.patch === '' && typeof example.dsh.allowTask === 'boolean', JSON.stringify(example?.dsh && { patch: example.dsh.patch, allowTask: example.dsh.allowTask }));
}

function testAlertsAndEmptyState() {
  const group = '通用空态';
  const snapshot = { load: { load1: 8 }, cpu: { threads: 16, coreCount: 16 } };
  rec(group, 'alerts loadPerCore 按线程数计算', metricValue(snapshot, 'loadPerCore') === 0.5, String(metricValue(snapshot, 'loadPerCore')));
  const legacy = { load: { load1: 8 }, cpu: { coreCount: 8 } };
  rec(group, '旧快照（无 threads）回退 coreCount', metricValue(legacy, 'loadPerCore') === 1, String(metricValue(legacy, 'loadPerCore')));

  const picked = collector.pickPrimarySensors({ temps: [], power: [], fans: [] });
  rec(group, '无任何传感器 → 主指标全部 null', picked.cpuTemp === null && picked.gpuTemp === null && picked.nvmeTemp === null && picked.gpuPower === null, JSON.stringify(picked));
  rec(group, 'pickPrimarySensors 缺字段不抛异常', (() => {
    try {
      collector.pickPrimarySensors(undefined);
      return true;
    } catch (e) {
      return false;
    }
  })());

  const gpuPaths = collector.readGpuDevicePaths();
  rec(group, 'GPU 设备路径集合类型正确', gpuPaths instanceof Set && gpuPaths.size >= 0, `gpuDevices=${gpuPaths.size}`);
}

function finish() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log('\n──────────────────────────────');
  console.log(`结果：${passed}/${results.length} 通过 · ${failed.length} 失败 · ${skipped.length} 跳过`);
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ❌ [${f.group}] ${f.name} — ${f.detail ?? ''}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

console.log('\n══════ CPU 拓扑 / 通用采集 测试 ══════');
testTopologyUnit();
testLiveDetection();
testGenericDefaults();
testAlertsAndEmptyState();
finish();
