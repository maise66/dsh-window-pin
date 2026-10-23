/**
 * dsh-window-pin —— Win32 置顶层。
 *
 * 为什么用 FFI 而不是 Electron API：DSH 的 Host 是桌面外壳（Electron main）
 * 用 Node 模式拉起的**子进程**，拿不到 BrowserWindow；外壳自身也没有
 * always-on-top 的 IPC 出口。直接改 app.asar 会在每次升级后被覆盖，所以这里
 * 只在宿主进程里调用官方随包附带的 koffi
 * (dsh-desktop-host/node_modules/koffi)，用 user32.dll 操作窗口的
 * WS_EX_TOPMOST 扩展样式，插件本身零侵入安装目录。
 *
 * 目标窗口 = 宿主进程父进程（Electron 主进程）下、可见的 Chrome_WidgetWin_1
 * 窗口里面积最大的那个，也就是 Harness 主窗口。
 *
 * 所有函数都是同步的（FFI 调用 + EnumWindows 回调），失败一律降级成
 * `{ ok: false, supported: false, reason }`，绝不让宿主进程抛异常。
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** GWL_EXSTYLE：扩展窗口样式在 GetWindowLongPtr 里的索引。 */
const GWL_EXSTYLE = -20;
/** WS_EX_TOPMOST：置顶窗口带的扩展样式位。 */
const WS_EX_TOPMOST = 0x0000_0008;
/** SetWindowPos 的 hWndInsertAfter 取值。 */
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
/** SetWindowPos 标志：只改 z 序，不动位置、尺寸、激活状态与 owner 关系。 */
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;
/** Harness 主窗口的 Chromium 顶层窗口类名。 */
const MAIN_WINDOW_CLASS = 'Chrome_WidgetWin_1';

/** 懒加载的 FFI 句柄与失败原因；进程内只解析一次。 */
let handle;
/** 懒加载的 user32 绑定集合（含 `reason` 表示不可用）；进程内只绑定一次。 */
let bound;

/** koffi 相对宿主入口解析：桌面外壳把它放在 dsh-desktop-host 自己的 node_modules 里。 */
function koffiCandidates() {
  const executable = process.execPath;
  return [
    // 宿主进程入口：<...>/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js
    process.argv[1],
    // 显式按安装位置拼一份，覆盖 argv[1] 不可用的场景。
    join(dirname(executable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
  ].filter((value) => typeof value === 'string' && value !== '');
}

/** 解析并加载 koffi；返回 { koffi } 或 { reason }。 */
function loadKoffi() {
  if (handle !== undefined) return handle;
  if (process.platform !== 'win32') {
    handle = { reason: `platform ${process.platform} is not supported (Windows only)` };
    return handle;
  }
  const attempts = [];
  for (const base of koffiCandidates()) {
    try {
      const require = createRequire(base);
      handle = { koffi: require('koffi'), from: require.resolve('koffi') };
      return handle;
    } catch (error) {
      attempts.push(`${base}: ${error?.message ?? String(error)}`);
    }
  }
  try {
    const require = createRequire(import.meta.url);
    handle = { koffi: require('koffi'), from: require.resolve('koffi') };
    return handle;
  } catch (error) {
    attempts.push(`plugin: ${error?.message ?? String(error)}`);
  }
  handle = { reason: `koffi (bundled FFI) is unavailable: ${attempts.join(' | ')}` };
  return handle;
}

/**
 * 加载 user32.dll 并声明用到的全部函数签名。
 *
 * @returns 绑定集合；不可用时返回带 `reason` 的对象（调用方按降级处理）。
 */
function loadUser32() {
  if (bound !== undefined) return bound;
  const loaded = loadKoffi();
  if (loaded.koffi === undefined) {
    bound = { reason: loaded.reason };
    return bound;
  }
  try {
    const user32 = loaded.koffi.load('user32.dll');
    bound = {
      koffi: loaded.koffi,
      from: loaded.from,
      user32,
      EnumWindows: user32.func('bool __stdcall EnumWindows(void *lpEnumFunc, intptr_t lParam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ char16_t *buf, int max)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ char16_t *buf, int max)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ int32 *rect)'),
      SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)'),
      // koffi 的回调原型按名字全局注册，同名重复声明会抛错，所以只建一次。
      EnumProc: loaded.koffi.pointer(loaded.koffi.proto('bool __stdcall DshWindowPinEnumProc(intptr_t hwnd, intptr_t lParam)')),
    };
  } catch (error) {
    bound = { reason: `user32.dll binding failed: ${error?.message ?? String(error)}` };
  }
  return bound;
}

/** 读取窗口类名或标题；读失败返回空串。 */
function readWindowText(thunk, hwnd, chars) {
  try {
    const buffer = Buffer.alloc(chars * 2);
    const length = thunk(hwnd, buffer, chars);
    if (!Number.isFinite(length) || length <= 0) return '';
    return buffer.toString('utf16le', 0, length * 2);
  } catch {
    return '';
  }
}

/** 列出某个进程的所有顶层窗口（类名 / 可见性 / 尺寸）。 */
function listWindows(bound, pid) {
  const found = [];
  const callback = bound.koffi.register((hwnd) => {
    try {
      const pidBuffer = Buffer.alloc(4);
      bound.GetWindowThreadProcessId(hwnd, pidBuffer);
      if (pidBuffer.readUInt32LE(0) !== pid) return true;
      const rect = Buffer.alloc(16);
      bound.GetWindowRect(hwnd, rect);
      found.push({
        hwnd: Number(hwnd),
        className: readWindowText(bound.GetClassNameW, hwnd, 256),
        title: readWindowText(bound.GetWindowTextW, hwnd, 512),
        visible: bound.IsWindowVisible(hwnd) === true,
        width: Math.max(0, rect.readInt32LE(8) - rect.readInt32LE(0)),
        height: Math.max(0, rect.readInt32LE(12) - rect.readInt32LE(4)),
      });
    } catch {
      // 单个窗口读失败不影响整轮枚举。
    }
    return true;
  }, bound.EnumProc);
  try {
    bound.EnumWindows(callback, 0);
  } finally {
    try {
      bound.koffi.unregister(callback);
    } catch {
      // 回调已随枚举结束失效时忽略。
    }
  }
  return found;
}

/**
 * 选中 Harness 主窗口：优先可见的 Chromium 顶层窗口里面积最大的一个；
 * 窗口全部隐藏（例如收进托盘）时退化为面积最大的同名类窗口。
 *
 * @param options.pid - 目标进程 id；默认取 `process.ppid`（桌面外壳主进程），
 *   显式传入只用于测试与诊断。
 */
function findMainWindow(options = {}) {
  const bound = loadUser32();
  if (bound.reason !== undefined) return { reason: bound.reason };
  const parent = Number(options.pid ?? process.ppid);
  if (!Number.isInteger(parent) || parent <= 0) return { reason: 'cannot determine the Electron main process id (process.ppid)' };
  const candidates = listWindows(bound, parent).filter((window) => window.className === MAIN_WINDOW_CLASS && window.width * window.height > 0);
  if (candidates.length === 0) return { reason: `no ${MAIN_WINDOW_CLASS} window belongs to process ${String(parent)}` };
  const byArea = (a, b) => b.width * b.height - a.width * a.height;
  const main = candidates.filter((window) => window.visible).sort(byArea)[0] ?? candidates.sort(byArea)[0];
  return { bound, window: main };
}

/**
 * 读当前置顶状态（直接问 Win32，不缓存，永远反映真实窗口）。
 *
 * @param options - 可选的 `pid` 覆盖，供测试与诊断使用。
 */
export function readPinned(options = {}) {
  const target = findMainWindow(options);
  if (target.window === undefined) return { ok: false, supported: false, reason: target.reason };
  try {
    const style = Number(target.bound.GetWindowLongPtrW(target.window.hwnd, GWL_EXSTYLE));
    return {
      ok: true,
      supported: true,
      pinned: (style & WS_EX_TOPMOST) !== 0,
      window: { hwnd: target.window.hwnd, title: target.window.title },
    };
  } catch (error) {
    return { ok: false, supported: false, reason: `GetWindowLongPtrW failed: ${error?.message ?? String(error)}` };
  }
}

/**
 * 写入置顶状态，并回读确认。
 *
 * @param want - 目标状态。
 * @param options - 可选的 `pid` 覆盖，供测试与诊断使用。
 */
export function writePinned(want, options = {}) {
  const target = findMainWindow(options);
  if (target.window === undefined) return { ok: false, supported: false, reason: target.reason };
  const flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
  try {
    const applied = target.bound.SetWindowPos(
      target.window.hwnd,
      want ? HWND_TOPMOST : HWND_NOTOPMOST,
      0,
      0,
      0,
      0,
      flags,
    );
    const style = Number(target.bound.GetWindowLongPtrW(target.window.hwnd, GWL_EXSTYLE));
    const pinned = (style & WS_EX_TOPMOST) !== 0;
    if (applied !== true && pinned !== want) {
      return { ok: false, supported: true, pinned, reason: 'SetWindowPos was refused by the window manager', window: { hwnd: target.window.hwnd, title: target.window.title } };
    }
    return { ok: true, supported: true, pinned, window: { hwnd: target.window.hwnd, title: target.window.title } };
  } catch (error) {
    return { ok: false, supported: false, reason: `SetWindowPos failed: ${error?.message ?? String(error)}` };
  }
}

/**
 * 切换置顶状态，返回切换后的状态。
 *
 * @param options - 可选的 `pid` 覆盖，供测试与诊断使用。
 */
export function togglePinned(options = {}) {
  const current = readPinned(options);
  if (current.ok !== true) return current;
  return writePinned(current.pinned !== true, options);
}

/** 供宿主诊断：FFI 是否可用、绑定到了哪个 koffi。 */
export function describeSupport() {
  const loaded = loadUser32();
  return loaded.reason === undefined
    ? { supported: true, koffi: loaded.from, pid: process.pid, parentPid: Number(process.ppid) }
    : { supported: false, reason: loaded.reason, pid: process.pid, parentPid: Number(process.ppid) };
}
