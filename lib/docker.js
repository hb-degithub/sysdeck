'use strict';

/**
 * Docker 管理模块
 * 通过 Unix Socket 直接调用 Docker Engine REST API，无需 docker CLI，无需 npm 依赖。
 *
 * 权限说明：
 *  - 访问 /var/run/docker.sock 需要 root 或 docker 组成员
 *  - 无权限时返回明确错误，前端显示引导而非报错崩溃
 */

const http = require('node:http');
const fs = require('node:fs');

const CANDIDATE_SOCKETS = [
  process.env.DOCKER_SOCKET,
  '/var/run/docker.sock',
  '/run/docker.sock',
  `${process.env.HOME || '/root'}/.docker/run/docker.sock`,
].filter(Boolean);

class DockerError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'DockerError';
    this.code = code;
    this.status = status;
  }
}

class DockerClient {
  constructor(options = {}) {
    this.socketPath = options.socketPath || null;
    // 仅在探测失败时作为兜底；正常情况下由 probe() 按服务端能力协商
    this.apiVersion = options.apiVersion || 'v1.44';
    this.timeout = options.timeout || 15000;
    this._probeCache = null;
    this._probeAt = 0;
  }

  /** 探测可用的 socket 与权限状态 */
  async probe(force = false) {
    const now = Date.now();
    if (!force && this._probeCache && now - this._probeAt < 10000) {
      return this._probeCache;
    }

    const report = {
      installed: false,
      reachable: false,
      socket: null,
      version: null,
      apiVersion: null,
      error: null,
      permissionDenied: false,
      candidates: [],
    };

    const ordered = this.socketPath
      ? [this.socketPath, ...CANDIDATE_SOCKETS.filter((x) => x !== this.socketPath)]
      : CANDIDATE_SOCKETS;

    for (const sock of ordered) {
      let exists = false;
      try {
        exists = fs.existsSync(sock);
      } catch (e) {
        exists = false;
      }
      report.candidates.push({ socket: sock, exists });
      if (!exists) continue;

      try {
        const resp = await this._rawRequest(sock, '/version', { timeout: 5000 });
        const v = resp.body || {};
        this.socketPath = sock;
        report.installed = true;
        report.reachable = true;
        report.socket = sock;
        report.version = v.Version;
        report.apiVersion = v.ApiVersion;
        // 按服务端支持的版本协商：优先采用服务端上报版本
        // （钉死低版本会被新版 Docker 以 "client version too old" 拒绝）
        if (v.ApiVersion) this.apiVersion = `v${v.ApiVersion}`;
        report.os = v.Os;
        report.arch = v.Arch;
        report.kernel = v.KernelVersion;
        report.error = null;
        break;
      } catch (e) {
        if (e.status === 403 || /permission|EACCES/i.test(e.message)) {
          report.installed = true;
          report.permissionDenied = true;
          report.socket = sock;
        }
        report.error = e.message;
      }
    }

    // 未找到 socket 时，检查 docker 二进制是否存在
    if (!report.installed) {
      report.installed = fileExists('/usr/bin/docker') || fileExists('/usr/local/bin/docker');
    }

    this._probeCache = report;
    this._probeAt = now;
    return report;
  }

  /** 底层请求：直接指定 socket */
  _rawRequest(socketPath, path, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path,
          method: options.method || 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
          },
          timeout: options.timeout || this.timeout,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (options.binary) {
              if (res.statusCode >= 400) {
                return reject(
                  new DockerError(buf.toString('utf8') || `Docker API 返回 ${res.statusCode}`, 'HTTP_ERROR', res.statusCode)
                );
              }
              return resolve({ body: buf, headers: res.headers });
            }
            const text = buf.toString('utf8');
            let body = text;
            if (text && (text.trimStart().startsWith('{') || text.trimStart().startsWith('['))) {
              try {
                body = JSON.parse(text);
              } catch (e) {
                /* 保留文本 */
              }
            }
            if (res.statusCode >= 400) {
              const msg =
                (body && typeof body === 'object' && (body.message || body.error)) ||
                `Docker API 返回 ${res.statusCode}`;
              return reject(new DockerError(String(msg), 'HTTP_ERROR', res.statusCode));
            }
            resolve({ body, headers: res.headers });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new DockerError('Docker API 请求超时', 'TIMEOUT'));
      });
      req.on('error', (e) => {
        if (e.code === 'ENOENT') {
          reject(new DockerError('Docker socket 不存在（Docker 可能未安装或未启动）', 'ENOENT'));
        } else if (e.code === 'EACCES' || e.code === 'EPERM') {
          reject(
            new DockerError(
              '无权访问 Docker socket。请将用户加入 docker 组：sudo usermod -aG docker $USER',
              'EPERM'
            )
          );
        } else {
          reject(new DockerError(e.message, e.code || 'UNKNOWN'));
        }
      });

      if (options.body !== undefined) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  /** 带自动探测的请求 */
  async _api(path, options = {}) {
    if (!this.socketPath) {
      const probe = await this.probe();
      if (!probe.reachable) {
        throw new DockerError(probe.error || 'Docker 不可用', 'UNAVAILABLE');
      }
      this.socketPath = probe.socket;
    }

    try {
      const res = await this._rawRequest(this.socketPath, path, options);
      return res.body;
    } catch (e) {
      // 版本不匹配（过旧/过新）→ 重新协商 API 版本后重试一次
      const msg = String(e.message || '');
      if (!/client version .* (too old|too new)|minimum supported API version/i.test(msg)) {
        throw e;
      }
      this._probeCache = null;
      const probe = await this.probe(true);
      if (!probe.reachable) throw e;

      // 把路径里的版本段替换成协商后的版本
      const rewritten = path.replace(/^\/v\d+\.\d+/, `/${this.apiVersion}`);
      const res = await this._rawRequest(this.socketPath, rewritten, options);
      return res.body;
    }
  }

  /* ================= 容器 ================= */

  async listContainers(all = true) {
    const list = await this._api(`/${this.apiVersion}/containers/json?all=${all ? 1 : 0}`);
    if (!Array.isArray(list)) return [];

    return list.map((c) => ({
      id: c.Id,
      shortId: c.Id.slice(0, 12),
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      image: c.Image,
      imageId: c.ImageID,
      command: c.Command,
      created: c.Created * 1000,
      state: c.State,
      status: c.Status,
      ports: (c.Ports || []).map((p) => ({
        ip: p.IP,
        privatePort: p.PrivatePort,
        publicPort: p.PublicPort,
        type: p.Type,
      })),
      labels: c.Labels || {},
      mounts: (c.Mounts || []).map((m) => ({
        type: m.Type,
        source: m.Source,
        destination: m.Destination,
        rw: m.RW,
      })),
      networkMode: c.HostConfig?.NetworkMode || '',
    }));
  }

  async inspectContainer(id) {
    return this._api(`/${this.apiVersion}/containers/${encodeURIComponent(id)}/json`);
  }

  /** 容器日志（tail 模式，非流式） */
  async containerLogs(id, tail = 200) {
    const body = await this._api(
      `/${this.apiVersion}/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=0`,
      { timeout: 20000, binary: true }
    );
    return parseLogStream(body);
  }

  /** 容器资源快照 */
  async containerStats(id) {
    const raw = await this._api(
      `/${this.apiVersion}/containers/${encodeURIComponent(id)}/stats?stream=false`,
      { timeout: 15000 }
    );
    return summarizeStats(raw);
  }

  /** 容器操作 */
  async containerAction(id, action) {
    const allowed = {
      start: 'start',
      stop: 'stop',
      restart: 'restart',
      pause: 'pause',
      unpause: 'unpause',
      kill: 'kill',
    };
    const verb = allowed[action];
    if (!verb) throw new DockerError(`不支持的操作：${action}`, 'INVALID_ACTION');
    await this._api(`/${this.apiVersion}/containers/${encodeURIComponent(id)}/${verb}`, {
      method: 'POST',
      timeout: 60000,
    });
    return { ok: true, action, id };
  }

  async removeContainer(id, force = false) {
    await this._api(
      `/${this.apiVersion}/containers/${encodeURIComponent(id)}?force=${force ? 1 : 0}&v=1`,
      { method: 'DELETE', timeout: 60000 }
    );
    return { ok: true };
  }

  /* ================= 镜像 ================= */

  async listImages() {
    const list = await this._api(`/${this.apiVersion}/images/json?all=0`);
    if (!Array.isArray(list)) return [];
    return list.map((i) => ({
      id: i.Id,
      shortId: i.Id.replace(/^sha256:/, '').slice(0, 12),
      tags: i.RepoTags && i.RepoTags.length > 0 ? i.RepoTags : ['<none>:<none>'],
      digests: i.RepoDigests || [],
      size: i.Size,
      sharedSize: i.SharedSize || 0,
      created: i.Created * 1000,
      containers: i.Containers || 0,
    }));
  }

  async removeImage(id, force = false) {
    await this._api(
      `/${this.apiVersion}/images/${encodeURIComponent(id)}?force=${force ? 1 : 0}`,
      { method: 'DELETE', timeout: 120000 }
    );
    return { ok: true };
  }

  /* ================= 体积 / 网络 / 系统 ================= */

  async listVolumes() {
    const data = await this._api(`/${this.apiVersion}/volumes`);
    const vols = data?.Volumes || [];
    return vols.map((v) => ({
      name: v.Name,
      driver: v.Driver,
      mountpoint: v.Mountpoint,
      scope: v.Scope,
      created: v.CreatedAt,
      labels: v.Labels || {},
    }));
  }

  async listNetworks() {
    const list = await this._api(`/${this.apiVersion}/networks`);
    if (!Array.isArray(list)) return [];
    return list.map((n) => ({
      id: n.Id,
      shortId: n.Id.slice(0, 12),
      name: n.Name,
      // Docker 的 "none" 网络 driver 字段实际是字符串 "null"，归一化为空
      driver: n.Driver && n.Driver !== 'null' ? n.Driver : '',
      scope: n.Scope,
      internal: Boolean(n.Internal),
      attachable: Boolean(n.Attachable),
      containers: Object.keys(n.Containers || {}).length,
      subnet: n.IPAM?.Config?.[0]?.Subnet || '',
      gateway: n.IPAM?.Config?.[0]?.Gateway || '',
    }));
  }

  async composeProjects() {
    return groupComposeProjects(await this.listContainers(true));
  }

  async systemInfo() {
    const info = await this._api(`/${this.apiVersion}/info`);
    return {
      name: info.Name,
      serverVersion: info.ServerVersion,
      containers: info.Containers,
      containersRunning: info.ContainersRunning,
      containersPaused: info.ContainersPaused,
      containersStopped: info.ContainersStopped,
      images: info.Images,
      driver: info.Driver,
      loggingDriver: info.LoggingDriver,
      cgroupDriver: info.CgroupDriver,
      cgroupVersion: info.CgroupVersion,
      kernelVersion: info.KernelVersion,
      operatingSystem: info.OperatingSystem,
      osType: info.OSType,
      architecture: info.Architecture,
      cpus: info.NCPU,
      memTotal: info.MemTotal,
      dockerRootDir: info.DockerRootDir,
      storageDriver: info.Driver,
      warnings: info.Warnings || [],
    };
  }

  async diskUsage() {
    const d = await this._api(`/${this.apiVersion}/system/df`);
    const sum = (arr, key) => (arr || []).reduce((a, x) => a + (x[key] || 0), 0);
    return {
      images: { count: (d.Images || []).length, size: sum(d.Images, 'Size') },
      containers: { count: (d.Containers || []).length, size: sum(d.Containers, 'SizeRw') },
      volumes: {
        count: (d.Volumes || []).length,
        size: (d.Volumes || []).reduce((a, v) => a + (v.UsageData?.Size || 0), 0),
      },
      buildCache: { count: (d.BuildCache || []).length, size: sum(d.BuildCache, 'Size') },
      layersSize: d.LayersSize || 0,
    };
  }
}

/* ================= 辅助函数 ================= */

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
}

/**
 * 解析 Docker 日志的多路复用流
 * 格式：[STREAM_TYPE(1B)][PADDING(3B)][SIZE(4B BE)][PAYLOAD(SIZE)]
 */
function parseLogStream(raw) {
  if (typeof raw === 'string') {
    return raw.split('\n').filter((l) => l.length > 0);
  }
  if (!Buffer.isBuffer(raw)) {
    return String(raw ?? '').split('\n').filter((l) => l.length > 0);
  }

  const lines = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const streamType = raw[offset];
    if (streamType !== 0 && streamType !== 1 && streamType !== 2) break;
    const size = raw.readUInt32BE(offset + 4);
    offset += 8;
    if (size < 0 || offset + size > raw.length) break;
    lines.push(raw.subarray(offset, offset + size).toString('utf8'));
    offset += size;
  }

  if (lines.length === 0) {
    return raw.toString('utf8').split('\n').filter((l) => l.length > 0);
  }
  return lines.join('').split('\n').filter((l) => l.length > 0);
}

/** 把 Docker stats 原始数据换算成可读指标 */
function summarizeStats(stats) {
  if (!stats || typeof stats !== 'object') return null;

  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage || 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const sysDelta =
    (stats.cpu_stats?.system_cpu_usage || 0) - (stats.precpu_stats?.system_cpu_usage || 0);
  const onlineCpus =
    stats.cpu_stats?.online_cpus ||
    stats.cpu_stats?.cpu_usage?.percpu_usage?.length ||
    1;

  let cpuPercent = 0;
  if (sysDelta > 0 && cpuDelta > 0) {
    cpuPercent = (cpuDelta / sysDelta) * onlineCpus * 100;
  }

  const usage = stats.memory_stats?.usage || 0;
  const limit = stats.memory_stats?.limit || 0;
  const cache = stats.memory_stats?.stats?.cache || stats.memory_stats?.stats?.inactive_file || 0;
  const effectiveUsage = Math.max(0, usage - cache);

  let rx = 0;
  let tx = 0;
  if (stats.networks) {
    for (const n of Object.values(stats.networks)) {
      rx += n.rx_bytes || 0;
      tx += n.tx_bytes || 0;
    }
  }

  let readBytes = 0;
  let writeBytes = 0;
  if (stats.blkio_stats?.io_service_bytes_recursive) {
    for (const entry of stats.blkio_stats.io_service_bytes_recursive) {
      if (entry.op === 'read' || entry.op === 'Read') readBytes += entry.value || 0;
      if (entry.op === 'write' || entry.op === 'Write') writeBytes += entry.value || 0;
    }
  }

  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memUsage: effectiveUsage,
    memLimit: limit,
    memPercent: limit > 0 ? Math.round((effectiveUsage / limit) * 10000) / 100 : 0,
    pids: stats.pids_stats?.current || 0,
    networkRx: rx,
    networkTx: tx,
    blockRead: readBytes,
    blockWrite: writeBytes,
  };
}


/* ---------------- compose 聚合 / 容器引用校验 ---------------- */

const CONTAINER_HEX_RE = /^[0-9a-f]{12,64}$/i;
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * 校验容器 id / 名称（拒绝任何 shell 元字符；仅 hex id 或 Docker 合法名称）。
 * @returns {{ok:true,value:string}|{ok:false,error:string}}
 */
function validateContainerRef(value) {
  const ref = String(value || '').trim();
  if (!ref) return { ok: false, error: 'container 不能为空' };
  if (ref.length > 128) return { ok: false, error: 'container 过长' };
  if (CONTAINER_HEX_RE.test(ref) || CONTAINER_NAME_RE.test(ref)) return { ok: true, value: ref };
  return { ok: false, error: 'container 必须是 12..64 位 hex id 或合法容器名' };
}

/**
 * 按 compose 项目聚合容器列表。
 * @param {Array} containers docker.listContainers() 的返回
 */
function groupComposeProjects(containers) {
  const projects = new Map();
  for (const container of Array.isArray(containers) ? containers : []) {
    const labels = container.labels || {};
    const projectName = labels['com.docker.compose.project'];
    if (!projectName) continue;
    let project = projects.get(projectName);
    if (!project) {
      project = { name: projectName, status: 'stopped', running: 0, total: 0, services: [] };
      projects.set(projectName, project);
    }
    project.total += 1;
    if (container.state === 'running') project.running += 1;
    project.services.push({
      name: labels['com.docker.compose.service'] || container.name,
      id: container.shortId || String(container.id || '').slice(0, 12),
      containerName: container.name,
      state: container.state,
      status: container.status,
      image: container.image,
      ports: container.ports || [],
    });
  }
  for (const project of projects.values()) {
    project.services.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    project.status = project.running === project.total && project.total > 0 ? 'running' : project.running > 0 ? 'partial' : 'stopped';
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 单例 */
let singleton = null;
function getDockerClient() {
  if (!singleton) singleton = new DockerClient();
  return singleton;
}

module.exports = { DockerClient, DockerError, getDockerClient, summarizeStats, parseLogStream, validateContainerRef, groupComposeProjects };
