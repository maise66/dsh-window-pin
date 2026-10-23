/**
 * dsh-window-pin —— Host half（host.js）的离线验收。
 *
 * 用假的 Cordis ctx 加载真正的 host.js，把 `/window-pin/state` 与
 * `/window-pin/set` 当成真实请求驱动一遍（含方法/媒体类型/JSON 校验、未授权
 * 拒绝、卸载），并确认窗口状态真的被切换。断言结束后窗口回到未置顶。
 *
 * 用法：
 *   $exe = "C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
 *   $pid = (Get-CimInstance Win32_Process -Filter "Name like '%DeepSeek Harness%'" |
 *           Where-Object { $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*--expose-internals*' }).ProcessId
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & $exe test/host.test.mjs --pid $pid
 *
 * 注意：这里显式传 `config.pid`，因为本进程的父进程不是 Electron 主进程。
 */
import { EventEmitter } from 'node:events';
import { apply } from '../host.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const pid = Number(flag('pid', '0'));

const failures = [];
function check(label, condition, detail) {
  const line = `${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`;
  console.log(line);
  if (!condition) failures.push(line);
}

/** 收集 apply() 通过 ctx.inject / scope.effect 注册出来的路线。 */
const routes = new Map();
const disposers = [];
let injectedServices = null;

const scope = {
  connection: {
    // 默认授权；下面会临时改成拒绝来验证 401 分支。
    requestRejection: () => undefined,
  },
  webServer: {
    register(config) {
      routes.set(config.path, config);
      const dispose = () => routes.delete(config.path);
      disposers.push(dispose);
      return dispose;
    },
  },
  effect(callback, label) {
    const dispose = callback();
    disposers.push(typeof dispose === 'function' ? dispose : () => {});
    console.log(`# effect registered :: ${label}`);
    return () => {};
  },
};

apply({ inject: (services, callback) => { injectedServices = services; callback(scope); } }, { enabled: true, pid });

check('injected webServer+connection', Array.isArray(injectedServices) && injectedServices.includes('webServer') && injectedServices.includes('connection'), injectedServices);
check('both routes registered', routes.has('/window-pin/state') && routes.has('/window-pin/set'), [...routes.keys()]);
check('routes are exact kind', [...routes.values()].every((route) => route.kind === 'exact'), [...routes.keys()]);

/** 造一个够用的请求：EventEmitter + method/headers，body 异步送达。 */
function makeRequest(method, { body, contentType = 'application/json' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = body === undefined ? {} : { 'content-type': contentType };
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(body, 'utf8'));
      req.emit('end');
    });
  }
  return req;
}

/** 造一个记录响应的 res。 */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body; },
  };
}

/** 发一次“请求”，返回 { status, json, headers }。 */
async function call(path, method, options) {
  const handler = routes.get(path)?.handler;
  if (handler === undefined) throw new Error(`no handler for ${path}`);
  const res = makeResponse();
  await handler(makeRequest(method, options), res);
  let json;
  try {
    json = res.body === undefined || res.body === '' ? undefined : JSON.parse(res.body);
  } catch {
    json = { raw: res.body };
  }
  return { status: res.statusCode, json, headers: res.headers };
}

// --- 正常路径 -------------------------------------------------------------
const initial = await call('/window-pin/state', 'GET');
console.log(`state :: ${JSON.stringify(initial.json)}`);
check('GET state answers 200 + supported', initial.status === 200 && initial.json?.ok === true && initial.json?.supported === true, initial.json);
check('state carries window handle and support diagnostics', typeof initial.json?.window?.hwnd === 'number' && initial.json?.support?.supported === true, initial.json);
if (initial.json?.pinned === true) await call('/window-pin/set', 'POST', { body: JSON.stringify({ pinned: false }) });

const on = await call('/window-pin/set', 'POST', { body: JSON.stringify({ pinned: true }) });
console.log(`set true :: ${JSON.stringify(on.json)}`);
check('POST set true answers pinned:true', on.status === 200 && on.json?.ok === true && on.json?.pinned === true, on.json);
check('GET state confirms the window is topmost', (await call('/window-pin/state', 'GET')).json?.pinned === true);

const off = await call('/window-pin/set', 'POST', { body: JSON.stringify({ pinned: false }) });
console.log(`set false :: ${JSON.stringify(off.json)}`);
check('POST set false answers pinned:false', off.status === 200 && off.json?.ok === true && off.json?.pinned === false, off.json);
check('GET state confirms the window is back to normal', (await call('/window-pin/state', 'GET')).json?.pinned === false);

const toggled = await call('/window-pin/set', 'POST', { body: '' });
check('POST without body toggles', toggled.status === 200 && toggled.json?.pinned === true, toggled.json);
const toggledBack = await call('/window-pin/set', 'POST', { body: '{}' });
check('POST {} toggles again', toggledBack.status === 200 && toggledBack.json?.pinned === false, toggledBack.json);

// --- 校验与拒绝路径 -------------------------------------------------------
const wrongMethod = await call('/window-pin/set', 'GET');
check('GET on the set route is 405', wrongMethod.status === 405, { status: wrongMethod.status, allow: wrongMethod.headers.allow });

const wrongState = await call('/window-pin/state', 'POST', { body: '{}' });
check('POST on the state route is 405', wrongState.status === 405, { status: wrongState.status, allow: wrongState.headers.allow });

const wrongType = await call('/window-pin/set', 'POST', { body: '{}', contentType: 'text/plain' });
check('text/plain body is 415', wrongType.status === 415, wrongType.json);

const badJson = await call('/window-pin/set', 'POST', { body: 'not json' });
check('invalid JSON body is 400', badJson.status === 400, badJson.json);

const badField = await call('/window-pin/set', 'POST', { body: JSON.stringify({ pinned: 'yes' }) });
check('non-boolean pinned is 400', badField.status === 400, badField.json);

const arrayBody = await call('/window-pin/set', 'POST', { body: '[]' });
check('non-object body is 400', arrayBody.status === 400, arrayBody.json);

scope.connection.requestRejection = () => 401;
const rejected = await call('/window-pin/state', 'GET');
check('untrusted caller is rejected with the connection status', rejected.status === 401, { status: rejected.status });
scope.connection.requestRejection = () => undefined;

// --- 卸载路径 -------------------------------------------------------------
for (const dispose of disposers.reverse()) dispose();
check('disposers removed every route', routes.size === 0, [...routes.keys()]);

console.log(failures.length === 0 ? 'RESULT OK (host)' : `RESULT FAILED (host): ${failures.length}`);
process.exitCode = failures.length === 0 ? 0 : 1;
