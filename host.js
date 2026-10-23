/**
 * dsh-window-pin Host half —— Harness 窗口置顶开关的宿主实现。
 *
 * 只注册两条 HTTP 路由，供 client.js 里的标题栏按钮调用：
 *
 *   GET  /window-pin/state  → { ok, supported, pinned, window, support, version }
 *   POST /window-pin/set    → body `{"pinned":true|false}`（省略则取反）
 *
 * 真正的窗口操作在 lib/topmost.js：宿主进程用桌面外壳自带的 koffi 调
 * user32.dll，切换 Electron 主窗口（`process.ppid`）的 WS_EX_TOPMOST。
 * 非 Windows、没有 koffi、找不到窗口时全部降级成
 * `{ ok:false, supported:false, reason }`，不抛异常、不影响宿主功能。
 *
 * 配置（可在 profile 的 cordis.patch.yml 里覆盖）：
 * - `enabled` {boolean} 置 false 关闭整个插件（默认 true）
 * - `pid`     {number}  目标窗口所属进程 id，默认宿主进程的父进程
 *                       （Electron 主进程）；只在外壳进程结构不同的时候才需要
 *
 * 注意 `?gen=N`：Node 的 ESM 注册表按说明符缓存模块，而宿主是长期存活的
 * 进程，所以改动 lib/topmost.js 后必须同时递增这里和 client 无关的 N，
 * 新代码才会真正生效（与 dsh-cache-cleaner 的做法一致）。
 */

import { describeSupport, readPinned, togglePinned, writePinned } from './lib/topmost.js?gen=1';

/** 浏览器半读取状态的路线。 */
const STATE_ROUTE = '/window-pin/state';
/** 浏览器半写入状态的路线。 */
const SET_ROUTE = '/window-pin/set';

/** 宿主入口版本号：改接口形状时递增，便于排查残留模块代次。 */
const PLUGIN_VERSION = 1;

/** 连接层拒绝请求但没给状态码时的兜底状态。 */
const FALLBACK_REJECTION = 403;

/** 发送 JSON 响应。 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** 读取有上限的请求体文本。 */
function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 对外统一的状态负载：诊断信息只在请求态里带，便于排查。 */
function statePayload(result) {
  return {
    ok: result.ok === true,
    supported: result.supported === true,
    version: PLUGIN_VERSION,
    ...result.pinned === undefined ? {} : { pinned: result.pinned },
    ...result.reason === undefined ? {} : { reason: result.reason },
    ...result.window === undefined ? {} : { window: result.window },
  };
}

export function apply(ctx, config) {
  if (config?.enabled === false) return;

  // 目标进程：默认父进程（Electron 主进程）；诊断/特殊部署可用 config.pid 指定。
  const target = Number.isInteger(config?.pid) && config.pid > 0 ? { pid: config.pid } : {};

  ctx.inject(['webServer', 'connection'], (scope) => {
    const rejectUntrusted = (req, res) => {
      const rejection = scope.connection.requestRejection(req);
      if (rejection === undefined || rejection === null) return false;
      res.statusCode = Number(rejection) || FALLBACK_REJECTION;
      res.end();
      return true;
    };

    // --- 状态查询：按钮挂载时对齐真实窗口状态 ------------------------------
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: (req, res) => {
        if (rejectUntrusted(req, res)) return;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET, HEAD');
          res.end();
          return;
        }
        sendJson(res, 200, { ...statePayload(readPinned(target)), support: describeSupport() });
      },
    }), 'window-pin: GET /window-pin/state');

    // --- 状态写入：点击按钮时调用 -----------------------------------------
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: SET_ROUTE,
      handler: async (req, res) => {
        if (rejectUntrusted(req, res)) return;
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('allow', 'POST');
          res.end();
          return;
        }
        const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== '' && contentType !== 'application/json') {
          sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
          return;
        }
        let body;
        try {
          const raw = await readBody(req);
          body = raw.trim() === '' ? {} : JSON.parse(raw);
        } catch (error) {
          sendJson(res, 400, { ok: false, error: `invalid body: ${error?.message ?? String(error)}` });
          return;
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: 'body must be a JSON object' });
          return;
        }
        if (body.pinned !== undefined && typeof body.pinned !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'pinned must be a boolean when present' });
          return;
        }
        try {
          // 显式目标状态优先（避免连点竞态），缺省时由宿主自己取反。
          const result = typeof body.pinned === 'boolean' ? writePinned(body.pinned, target) : togglePinned(target);
          sendJson(res, 200, statePayload(result));
        } catch (error) {
          sendJson(res, 500, { ok: false, supported: true, error: error?.message ?? String(error) });
        }
      },
    }), 'window-pin: POST /window-pin/set');
  });
}
