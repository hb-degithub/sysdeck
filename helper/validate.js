'use strict';

/**
 * panel-helper 参数白名单校验（纯函数，无副作用，便于单元测试）
 *
 * 所有函数返回 `{ok:true, value}` 或 `{ok:false, error:'...'}`；
 * error 文案不含调用方输入（避免把恶意参数回显进日志/响应）。
 */

const path = require('node:path');

const SERVICE_ACTIONS = ['status', 'start', 'stop', 'restart', 'enable', 'disable'];
const KILL_SIGNALS = ['TERM', 'KILL'];
const POWER_ACTIONS = ['reboot', 'shutdown', 'cancel'];
const FIREWALL_ACTIONS = ['status', 'allow', 'deny', 'delete', 'enable', 'disable'];
const PACKAGE_ACTIONS = ['upgradable', 'update', 'upgrade'];
const CRON_ACTIONS = ['list', 'write'];
const MOUNT_ACTIONS = ['list', 'mount', 'umount'];

const MAX_CRON_LINES = 100;
const MAX_CRON_LINE_LEN = 500;
const UNIT_RE = /^[A-Za-z0-9@._-]+\.(service|timer)$/;
const MOUNT_POINT_PREFIXES = ['/mnt/', '/media/'];
const FIREWALL_PROTO_RE = /^(tcp|udp|any)$/;
const PROFILE_RE = /^[A-Za-z0-9 ._+()-]{1,64}$/;
const DEVICE_RE = /^\/dev\/[A-Za-z0-9._/-]+$/;

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });
const str = (value) => (typeof value === 'string' ? value : '');

function validateServiceUnit(unit) {
  const value = str(unit).trim();
  if (!value || value.length > 200) return fail('unit 名非法');
  if (!UNIT_RE.test(value)) return fail('unit 名必须匹配 <name>.service|.timer');
  return ok(value);
}

function validateServiceAction(action) {
  return SERVICE_ACTIONS.includes(action) ? ok(action) : fail('service action 非法');
}

function validatePid(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 1 || value > 2147483647) return fail('pid 必须是 >1 的整数');
  return ok(value);
}

function validateSignal(signal) {
  const value = str(signal).toUpperCase();
  return KILL_SIGNALS.includes(value) ? ok(value) : fail('signal 仅允许 TERM/KILL');
}

function validateCronAction(action) {
  return CRON_ACTIONS.includes(action) ? ok(action) : fail('cron action 非法');
}

function validateCronLines(lines) {
  if (!Array.isArray(lines)) return fail('lines 必须是数组');
  if (lines.length > MAX_CRON_LINES) return fail(`crontab 最多 ${MAX_CRON_LINES} 行`);
  const out = [];
  for (const line of lines) {
    if (typeof line !== 'string') return fail('每一行必须是字符串');
    if (line.includes('\r') || line.includes('\0')) return fail('行内含非法控制字符');
    if (line.length > MAX_CRON_LINE_LEN) return fail(`单行不得超过 ${MAX_CRON_LINE_LEN} 字符`);
    // 只允许可打印 ASCII 与 tab，避免控制字符污染 crontab
    if (!/^[\x20-\x7E\t]*$/.test(line)) return fail('行内含不可打印字符');
    out.push(line);
  }
  return ok(out);
}

function validateMountDevice(device) {
  const value = str(device).trim();
  if (!value || value.length > 200) return fail('设备路径非法');
  if (!value.startsWith('/dev/')) return fail('设备必须在 /dev/ 下');
  if (value.includes('..') || !DEVICE_RE.test(value)) return fail('设备路径非法');
  return ok(value);
}

/** 挂载点：绝对路径、在 /mnt 或 /media 下、无 .. / . 段、规范化后与输入一致 */
function validateMountPoint(point) {
  const value = str(point).trim();
  if (!value || value.length > 200) return fail('挂载点非法');
  if (!value.startsWith('/')) return fail('挂载点必须是绝对路径');
  const normalized = path.posix.normalize(value);
  if (normalized !== value.replace(/\/+$/, '') && normalized !== value) return fail('挂载点必须规范化');
  if (normalized.includes('\0') || normalized.split('/').some((part) => part === '..' || part === '.')) {
    return fail('挂载点含非法路径段');
  }
  if (!MOUNT_POINT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return fail('挂载点必须在 /mnt 或 /media 下');
  }
  if (normalized === '/mnt' || normalized === '/media') return fail('挂载点不能是 /mnt 或 /media 根目录');
  return ok(normalized);
}

function validateMountAction(action) {
  return MOUNT_ACTIONS.includes(action) ? ok(action) : fail('mount action 非法');
}

function validateFirewallAction(action) {
  return FIREWALL_ACTIONS.includes(action) ? ok(action) : fail('firewall action 非法');
}

function validateFirewallPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return fail('端口必须是 1..65535 的整数');
  return ok(value);
}

function validateFirewallProto(proto) {
  const value = str(proto || 'any').toLowerCase();
  return FIREWALL_PROTO_RE.test(value) ? ok(value) : fail('proto 仅允许 tcp/udp/any');
}

function validateFirewallProfile(profile) {
  const value = str(profile).trim();
  if (!value || !PROFILE_RE.test(value)) return fail('app profile 名非法');
  return ok(value);
}

/**
 * 校验 allow/deny/delete 规则：port 与 profile 二选一。
 * @returns {{ok:true, value:{mode,port?:number,proto?:string,profile?:string}}|{ok:false,error:string}}
 */
function validateFirewallRule(args) {
  const raw = args && typeof args === 'object' ? args : {};
  const mode = raw.mode;
  if (!['allow', 'deny', 'delete'].includes(mode)) return fail('firewall 规则动作仅允许 allow/deny/delete');
  const hasPort = raw.port !== undefined && raw.port !== null && raw.port !== '';
  const hasProfile = raw.profile !== undefined && raw.profile !== null && raw.profile !== '';
  if (hasPort === hasProfile) return fail('port 与 profile 必须二选一');
  if (hasPort) {
    const port = validateFirewallPort(raw.port);
    if (!port.ok) return port;
    const proto = validateFirewallProto(raw.proto);
    if (!proto.ok) return proto;
    return ok({ mode, port: port.value, proto: proto.value });
  }
  const profile = validateFirewallProfile(raw.profile);
  if (!profile.ok) return profile;
  if (raw.proto !== undefined && raw.proto !== null && raw.proto !== '' && raw.proto !== 'any') {
    return fail('使用 profile 时不能指定 proto');
  }
  return ok({ mode, profile: profile.value });
}

function validatePowerAction(action) {
  return POWER_ACTIONS.includes(action) ? ok(action) : fail('power action 非法');
}

function validatePackageAction(action) {
  return PACKAGE_ACTIONS.includes(action) ? ok(action) : fail('packages action 非法');
}

module.exports = {
  SERVICE_ACTIONS,
  KILL_SIGNALS,
  POWER_ACTIONS,
  FIREWALL_ACTIONS,
  PACKAGE_ACTIONS,
  CRON_ACTIONS,
  MOUNT_ACTIONS,
  MAX_CRON_LINES,
  MAX_CRON_LINE_LEN,
  validateServiceUnit,
  validateServiceAction,
  validatePid,
  validateSignal,
  validateCronAction,
  validateCronLines,
  validateMountDevice,
  validateMountPoint,
  validateMountAction,
  validateFirewallAction,
  validateFirewallPort,
  validateFirewallProto,
  validateFirewallProfile,
  validateFirewallRule,
  validatePowerAction,
  validatePackageAction,
};
