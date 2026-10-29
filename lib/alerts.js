'use strict';

/**
 * 告警引擎
 *
 * - 每次采集快照（1s）调用 evaluate()，内部按 10s 节流评估
 * - 规则：{id, metric, op, value, durationSec, severity, enabled}
 * - 连续 durationSec 满足才触发；触发后冷却 cooldownMinutes 内不重复
 * - 连续 3 个评估周期不满足才恢复（可选恢复通知）
 * - 触发写 store.addAlert（带 severity），触发/恢复都写审计并异步发通知
 *
 * 纯内存状态；规则与开关来自 config.alerts（可被 config.json 覆盖，代码内有默认规则）。
 */

const METRIC_LABELS = Object.freeze({
  cpuPercent: 'CPU 使用率',
  memPercent: '内存使用率',
  swapPercent: 'Swap 使用率',
  diskPercent: '磁盘使用率',
  cpuTempC: 'CPU 温度',
  gpuTempC: 'GPU 温度',
  load1: '1 分钟负载',
  loadPerCore: '每核负载',
  netRxKBs: '网络接收速率',
  netTxKBs: '网络发送速率',
});

const METRICS = Object.keys(METRIC_LABELS);
const OPS = ['>', '>=', '<', '<='];
const SEVERITIES = ['warn', 'crit'];
const MAX_RULES = 30;
const RECOVER_CYCLES = 3;
const EVAL_INTERVAL_MS = 10000;

/** 代码内默认规则（可被 config.alerts.rules 覆盖） */
const DEFAULT_ALERT_RULES = Object.freeze([
  { id: 'cpu-high', metric: 'cpuPercent', op: '>', value: 90, durationSec: 60, severity: 'warn', enabled: true },
  { id: 'mem-high', metric: 'memPercent', op: '>', value: 90, durationSec: 60, severity: 'warn', enabled: true },
  { id: 'disk-high', metric: 'diskPercent', op: '>', value: 90, durationSec: 300, severity: 'crit', enabled: true },
  { id: 'cpu-temp-high', metric: 'cpuTempC', op: '>', value: 90, durationSec: 30, severity: 'crit', enabled: true },
  { id: 'load-per-core-high', metric: 'loadPerCore', op: '>', value: 1.5, durationSec: 300, severity: 'warn', enabled: true },
]);

function defaultAlertsConfig() {
  return {
    enabled: true,
    cooldownMinutes: 10,
    notifyOnRecover: true,
    rules: JSON.parse(JSON.stringify(DEFAULT_ALERT_RULES)),
  };
}

function invalidRulesError(detail) {
  const err = new Error(detail);
  err.code = 'invalid_rules';
  err.detail = detail;
  return err;
}

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function metricValue(snapshot, metric) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  switch (metric) {
    case 'cpuPercent':
      return num(snapshot.cpu?.percent);
    case 'memPercent':
      return num(snapshot.memory?.usedPercent);
    case 'swapPercent':
      return num(snapshot.memory?.swapPercent);
    case 'diskPercent': {
      const filesystems = Array.isArray(snapshot.filesystems) ? snapshot.filesystems : [];
      let max = null;
      for (const fs of filesystems) {
        const value = num(fs?.usedPercent);
        if (value === null) continue;
        if (max === null || value > max) max = value;
      }
      return max;
    }
    case 'cpuTempC':
      return num(snapshot.sensors?.cpuTemp ?? snapshot.cpu?.temp);
    case 'gpuTempC':
      return num(snapshot.sensors?.gpuTemp);
    case 'load1':
      return num(snapshot.load?.load1);
    case 'loadPerCore': {
      // 按逻辑线程数计算（与 UI 展示的 threads 一致；旧快照回退 coreCount）
      const load = num(snapshot.load?.load1);
      const threads = num(snapshot.cpu?.threads) || num(snapshot.cpu?.coreCount) || 0;
      return load !== null && threads > 0 ? load / threads : null;
    }
    case 'netRxKBs': {
      const list = Array.isArray(snapshot.network?.interfaces) ? snapshot.network.interfaces : [];
      let total = null;
      for (const iface of list) {
        const value = num(iface?.rxBytesPerSec);
        if (value === null) continue;
        total = (total === null ? 0 : total) + value;
      }
      return total === null ? null : total / 1024;
    }
    case 'netTxKBs': {
      const list = Array.isArray(snapshot.network?.interfaces) ? snapshot.network.interfaces : [];
      let total = null;
      for (const iface of list) {
        const value = num(iface?.txBytesPerSec);
        if (value === null) continue;
        total = (total === null ? 0 : total) + value;
      }
      return total === null ? null : total / 1024;
    }
    default:
      return null;
  }
}

function compare(value, op, threshold) {
  switch (op) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    default:
      return false;
  }
}

function opText(op) {
  return { '>': '超过', '>=': '达到', '<': '低于', '<=': '不高于' }[op] || op;
}

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  return Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * 归一化规则数组。
 * @param {unknown} input
 * @param {{strict?:boolean}} options strict=true 抛错；false 时非法输入回退默认规则
 * @returns {Array<object>}
 */
function normalizeRules(input, options = {}) {
  const strict = options.strict === true;
  if (!Array.isArray(input)) {
    if (strict) throw invalidRulesError('rules 必须是数组');
    return defaultAlertsConfig().rules;
  }
  if (input.length > MAX_RULES) {
    if (strict) throw invalidRulesError(`规则最多 ${MAX_RULES} 条`);
    input = input.slice(0, MAX_RULES);
  }
  const out = [];
  const seen = new Set();
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      if (strict) throw invalidRulesError(`rules[${index}] 必须是对象`);
      continue;
    }
    const metric = String(raw.metric || '');
    if (!METRICS.includes(metric)) {
      if (strict) throw invalidRulesError(`rules[${index}].metric 无效`);
      continue;
    }
    const op = String(raw.op || '');
    if (!OPS.includes(op)) {
      if (strict) throw invalidRulesError(`rules[${index}].op 必须是 > >= < <=`);
      continue;
    }
    const severity = String(raw.severity || 'warn');
    if (!SEVERITIES.includes(severity)) {
      if (strict) throw invalidRulesError(`rules[${index}].severity 必须是 warn/crit`);
      continue;
    }
    const value = Number(raw.value);
    if (!Number.isFinite(value)) {
      if (strict) throw invalidRulesError(`rules[${index}].value 必须是数值`);
      continue;
    }
    const durationSec = Number(raw.durationSec);
    if (!Number.isInteger(durationSec) || durationSec < 5 || durationSec > 3600) {
      if (strict) throw invalidRulesError(`rules[${index}].durationSec 必须是 5..3600 的整数`);
      continue;
    }
    let id = raw.id === undefined || raw.id === null || raw.id === '' ? `rule-${index + 1}` : String(raw.id);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      if (strict) throw invalidRulesError(`rules[${index}].id 只能是 1..64 位字母数字/下划线/连字符`);
      continue;
    }
    if (seen.has(id)) {
      if (strict) throw invalidRulesError(`规则 id 重复: ${id}`);
      continue;
    }
    seen.add(id);
    out.push({
      id,
      metric,
      op,
      value,
      durationSec,
      severity,
      enabled: raw.enabled !== false,
    });
  }
  return out;
}

/** 合并并校正 config.alerts（不抛错，非法规则回退默认） */
function normalizeAlertsConfig(raw) {
  const defaults = defaultAlertsConfig();
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = {
    enabled: src.enabled !== false,
    cooldownMinutes: clampInt(src.cooldownMinutes, 1, 1440, defaults.cooldownMinutes),
    notifyOnRecover: src.notifyOnRecover !== false,
    rules: normalizeRules(src.rules === undefined ? defaults.rules : src.rules, { strict: false }),
  };
  if (cfg.rules.length === 0) cfg.rules = defaults.rules;
  return cfg;
}

class AlertEngine {
  /**
   * @param {{config?:object, store?:object, notifier?:object, audit?:Function, logger?:object,
   *          now?:Function, evalIntervalMs?:number}} options
   */
  constructor(options = {}) {
    this.store = options.store || null;
    this.notifier = options.notifier || null;
    this.audit = typeof options.audit === 'function' ? options.audit : () => {};
    this.logger = options.logger || console;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.evalIntervalMs = clampInt(options.evalIntervalMs, 100, 60000, EVAL_INTERVAL_MS);

    this.configRef = options.config && typeof options.config === 'object' ? options.config : {};
    const normalized = normalizeAlertsConfig(this.configRef);
    Object.assign(this.configRef, normalized);
    this.config = this.configRef;
    this.rules = this.config.rules;

    /** id -> {conditionSince, failCount, firing, firedAt, lastFiredAt, lastValue} */
    this.state = new Map();
    this.lastEvalAt = null;
  }

  describe() {
    return {
      enabled: this.config.enabled,
      cooldownMinutes: this.config.cooldownMinutes,
      notifyOnRecover: this.config.notifyOnRecover,
      rules: this.rules.map((rule) => ({ ...rule })),
    };
  }

  stateView() {
    const firing = [];
    for (const rule of this.rules) {
      const state = this.state.get(rule.id);
      if (!state || !state.firing) continue;
      firing.push({
        id: rule.id,
        metric: rule.metric,
        value: state.lastValue,
        since: state.firedAt,
        severity: rule.severity,
      });
    }
    return { firing, lastEvalAt: this.lastEvalAt };
  }

  /** 更新规则/开关（严格校验，抛 {code:'invalid_rules'}） */
  update(payload = {}) {
    const body = payload && typeof payload === 'object' ? payload : {};
    const nextRules = body.rules === undefined ? this.rules : normalizeRules(body.rules, { strict: true });
    let enabled = this.config.enabled;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw invalidRulesError('enabled 必须是布尔值');
      enabled = body.enabled;
    }
    let cooldownMinutes = this.config.cooldownMinutes;
    if (body.cooldownMinutes !== undefined) {
      const n = Number(body.cooldownMinutes);
      if (!Number.isInteger(n) || n < 1 || n > 1440) throw invalidRulesError('cooldownMinutes 必须是 1..1440 的整数');
      cooldownMinutes = n;
    }
    let notifyOnRecover = this.config.notifyOnRecover;
    if (body.notifyOnRecover !== undefined) {
      if (typeof body.notifyOnRecover !== 'boolean') throw invalidRulesError('notifyOnRecover 必须是布尔值');
      notifyOnRecover = body.notifyOnRecover;
    }

    // 规则变化 → 重置对应状态；删除已移除规则的状态
    const previous = new Map(this.rules.map((rule) => [rule.id, rule]));
    const nextIds = new Set(nextRules.map((rule) => rule.id));
    for (const id of [...this.state.keys()]) {
      if (!nextIds.has(id)) this.state.delete(id);
    }
    for (const rule of nextRules) {
      const old = previous.get(rule.id);
      if (!old || JSON.stringify(old) !== JSON.stringify(rule)) this.state.delete(rule.id);
    }

    this.config.enabled = enabled;
    this.config.cooldownMinutes = cooldownMinutes;
    this.config.notifyOnRecover = notifyOnRecover;
    this.config.rules = nextRules;
    this.rules = nextRules;
    return { rules: nextRules.map((rule) => ({ ...rule })) };
  }

  /**
   * 评估快照（内部 10s 节流）。
   * @param {object} snapshot collector 快照
   * @param {number} [nowArg] 便于测试注入时间
   */
  evaluate(snapshot, nowArg) {
    if (!this.config.enabled) return;
    if (!snapshot || typeof snapshot !== 'object') return;
    const now = typeof nowArg === 'number' ? nowArg : this.now();
    if (this.lastEvalAt !== null && now - this.lastEvalAt < this.evalIntervalMs) return;
    this.lastEvalAt = now;

    for (const rule of this.rules) {
      const state = this.state.get(rule.id) || {
        conditionSince: null,
        failCount: 0,
        firing: false,
        firedAt: null,
        lastFiredAt: null,
        lastValue: null,
      };
      this.state.set(rule.id, state);

      if (!rule.enabled) {
        state.conditionSince = null;
        state.failCount = 0;
        state.firing = false;
        continue;
      }

      const value = metricValue(snapshot, rule.metric);
      state.lastValue = value;
      const satisfied = value !== null && compare(value, rule.op, rule.value);

      if (satisfied) {
        state.failCount = 0;
        if (state.conditionSince === null) state.conditionSince = now;
        if (!state.firing && now - state.conditionSince >= rule.durationSec * 1000) {
          const cooldownMs = this.config.cooldownMinutes * 60 * 1000;
          if (state.lastFiredAt !== null && now - state.lastFiredAt < cooldownMs) {
            // 冷却中：重新计时，冷却结束后仍需重新满足 duration
            state.conditionSince = now;
            continue;
          }
          this._fire(rule, state, value, now);
        }
      } else {
        state.conditionSince = null;
        if (state.firing) {
          state.failCount += 1;
          if (state.failCount >= RECOVER_CYCLES) this._recover(rule, state, now);
        } else {
          state.failCount = 0;
        }
      }
    }
  }

  _fire(rule, state, value, now) {
    state.firing = true;
    state.failCount = 0;
    state.firedAt = now;
    state.lastFiredAt = now;
    state.lastValue = value;

    const label = METRIC_LABELS[rule.metric] || rule.metric;
    const message = `${label} ${formatNumber(value)} ${opText(rule.op)}阈值 ${formatNumber(rule.value)}（持续 ${rule.durationSec}s）`;

    if (this.store) {
      try {
        this.store.addAlert(rule.metric, value, rule.value, message, rule.severity);
      } catch (e) {
        this.logger.warn?.(`[alerts] 写入告警失败: ${e.code || e.message}`);
      }
    }
    this.audit(`告警触发 [${rule.severity}] ${message}（规则 ${rule.id}）`);

    if (this.notifier) {
      try {
        const sent = this.notifier.sendAlert({
          type: 'alert',
          severity: rule.severity,
          metric: rule.metric,
          metricLabel: label,
          value: Math.round(value * 100) / 100,
          threshold: rule.value,
          durationSec: rule.durationSec,
          message,
          ruleId: rule.id,
        });
        if (sent && typeof sent.catch === 'function') sent.catch(() => {});
      } catch (e) {
        /* 通知失败不影响告警 */
      }
    }
  }

  _recover(rule, state, now) {
    state.firing = false;
    state.failCount = 0;
    state.conditionSince = null;
    state.lastValue = null;

    const label = METRIC_LABELS[rule.metric] || rule.metric;
    this.audit(`告警恢复 [${rule.severity}] ${label} 已恢复正常（规则 ${rule.id}）`);

    if (this.config.notifyOnRecover && this.notifier) {
      try {
        const sent = this.notifier.sendAlert({
          type: 'recover',
          severity: rule.severity,
          metric: rule.metric,
          metricLabel: label,
          value: null,
          threshold: rule.value,
          message: `${label} 已恢复正常`,
          ruleId: rule.id,
        });
        if (sent && typeof sent.catch === 'function') sent.catch(() => {});
      } catch (e) {
        /* ignore */
      }
    }
    void now;
  }
}

module.exports = {
  AlertEngine,
  DEFAULT_ALERT_RULES,
  METRICS,
  METRIC_LABELS,
  OPS,
  SEVERITIES,
  MAX_RULES,
  RECOVER_CYCLES,
  EVAL_INTERVAL_MS,
  defaultAlertsConfig,
  normalizeAlertsConfig,
  normalizeRules,
  metricValue,
  compare,
};
