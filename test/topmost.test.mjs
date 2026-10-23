/**
 * dsh-window-pin —— Win32 置顶层（lib/topmost.js）的离线验收。
 *
 * 用宿主同款运行时（桌面外壳的 Electron 以 Node 模式）对着**真实** Harness 窗口
 * 做读/写/切换，并覆盖异常路径；全程自己恢复现场，结束后窗口回到未置顶。
 *
 * 用法（先取 Electron 主进程 pid，即任务管理器里没有 --type= 的那个
 * "DeepSeek Harness.exe"，或用下面的 PowerShell 取）：
 *
 *   $exe = "C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
 *   $pid = (Get-CimInstance Win32_Process -Filter "Name like '%DeepSeek Harness%'" |
 *           Where-Object { $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*--expose-internals*' }).ProcessId
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & $exe test/topmost.test.mjs --pid $pid --mode matrix
 *
 * `--mode read|on|off|toggle` 只做单步，便于人工观察。
 */
import { describeSupport, readPinned, writePinned, togglePinned } from '../lib/topmost.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const pid = Number(flag('pid', '0'));
const mode = String(flag('mode', 'matrix'));
const failures = [];

function check(label, condition, detail) {
  const line = `${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`;
  console.log(line);
  if (!condition) failures.push(line);
}

console.log(`# runtime node=${process.versions.node} electron=${process.versions.electron ?? '-'} pid=${process.pid} ppid=${process.ppid} target=${pid}`);
console.log(`# support :: ${JSON.stringify(describeSupport())}`);

if (mode === 'read') {
  console.log(JSON.stringify(readPinned({ pid })));
} else if (mode === 'on' || mode === 'off') {
  const result = writePinned(mode === 'on', { pid });
  console.log(JSON.stringify(result));
  check(`write ${mode}`, result.ok === true && result.pinned === (mode === 'on'), result);
} else if (mode === 'toggle') {
  const result = togglePinned({ pid });
  console.log(JSON.stringify(result));
  check('toggle performed', result.ok === true, result);
} else {
  // 完整矩阵：读 → 置顶 → 读 → 取消 → 读 → 切换两次 → 异常路径。
  const initial = readPinned({ pid });
  console.log(`initial :: ${JSON.stringify(initial)}`);
  check('initial read ok', initial.ok === true && initial.supported === true, initial);
  if (initial.ok === true && initial.pinned === true) writePinned(false, { pid });

  const on = writePinned(true, { pid });
  console.log(`on :: ${JSON.stringify(on)}`);
  check('writePinned(true) reads back true', on.ok === true && on.pinned === true, on);
  check('readPinned sees true', readPinned({ pid }).pinned === true);

  const off = writePinned(false, { pid });
  console.log(`off :: ${JSON.stringify(off)}`);
  check('writePinned(false) reads back false', off.ok === true && off.pinned === false, off);
  check('readPinned sees false', readPinned({ pid }).pinned === false);

  const toggledOn = togglePinned({ pid });
  check('togglePinned -> true', toggledOn.ok === true && toggledOn.pinned === true, toggledOn);
  const toggledOff = togglePinned({ pid });
  check('togglePinned -> false', toggledOff.ok === true && toggledOff.pinned === false, toggledOff);

  const missing = readPinned({ pid: 999_999 });
  console.log(`missing pid :: ${JSON.stringify(missing)}`);
  check('unknown process degrades without throwing', missing.ok === false && missing.supported === false && typeof missing.reason === 'string', missing);

  check('window left unpinned', readPinned({ pid }).pinned === false);
}

console.log(failures.length === 0 ? `RESULT OK (${mode})` : `RESULT FAILED (${mode}): ${failures.length}`);
process.exitCode = failures.length === 0 ? 0 : 1;
