/**
 * dsh-window-pin browser half —— Harness 窗口标题栏上的“置顶”按钮。
 *
 * 位置：注册进 ui-layout 声明的 `shell.overlay` 列表槽（kind: list），叠在
 * Windows 自绘标题条（`--dsh-windows-titlebar-height`，40px）里。默认紧贴原生
 * 窗口按钮左侧；如果那片区域已被别的浮层占用（例如费用徽标），就用
 * `document.elementFromPoint` 逐格向左让位，始终保证按钮本身露得出来。
 *
 * 行为：挂载时 `GET /window-pin/state` 对齐真实状态；点击
 * `POST /window-pin/set {pinned}`；窗口重新获得焦点时再对齐一次（Windows 会在
 * 别的程序全屏时自动摘掉置顶）。非 Windows 桌面 / 宿主不可用时按钮显示为
 * 禁用并给出原因，不静默消失。
 *
 * 工厂保持无副作用：样式表作为 React 子节点渲染（卸载即移除），所有注册都在
 * `apply` 内完成并各自持有 disposer。
 */

window.__ModuleLoader__.load({
  id: 'dsh-window-pin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Client locale 服务上的命名空间。 */
    const NS = 'window-pin';

    /** 浏览器半版本号：只做诊断标记（座位元素上的 `data-dwp-version`），改动本文件时递增。 */
    const CLIENT_VERSION = 2;

    /** Host half 注册的路线。 */
    const STATE_ROUTE = '/window-pin/state';
    const SET_ROUTE = '/window-pin/set';

    /** 按钮尺寸与站位留白（CSS 像素）。 */
    const BUTTON_SIZE = 30;
    const SEAT_GAP = 8;
    /** Windows 原生窗口按钮（最小化/最大化/关闭）的兜底占位宽度。 */
    const FALLBACK_CONTROLS_WIDTH = 138;
    /** 让位探测的最大次数，防止病态布局里死循环。 */
    const MAX_SHIFT_STEPS = 32;

    const zh = {
      'action': '窗口置顶',
      'pin': '置顶：让 Harness 窗口始终显示在最前面',
      'unpin': '已置顶：点击取消置顶',
      'loading': '正在读取置顶状态…',
      'applying': '正在切换置顶状态…',
      'unsupported': '当前环境不支持窗口置顶',
      'failed': '置顶操作失败',
    };

    const en = {
      'action': 'Always on top',
      'pin': 'Keep the Harness window above other windows',
      'unpin': 'Pinned on top — click to unpin',
      'loading': 'Reading the pinned state…',
      'applying': 'Switching the pinned state…',
      'unsupported': 'Always-on-top is not available in this environment',
      'failed': 'The pin operation failed',
    };

    /**
     * 只用主题令牌；`dwp-` 前缀保证选择器都是自己的。样式表作为 React 子节点
     * 渲染，组件卸载时随之移除。
     */
    const CSS = `
.dwp-seat{position:absolute;top:0;height:var(--dsh-windows-titlebar-height,40px);display:flex;align-items:center;z-index:1;-webkit-app-region:no-drag}
.dwp-btn{display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;margin:0 8px 0 0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family,inherit);cursor:default;-webkit-app-region:no-drag}
.dwp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dwp-btn[data-pinned="true"]{color:var(--dsw-alias-brand-primary)}
.dwp-btn[data-pinned="true"]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.dwp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dwp-btn:disabled{color:var(--dsw-alias-label-tertiary)}
.dwp-btn[data-busy="true"]{opacity:.65}
`;

    /** 当前标题条高度（跟随外壳写入的令牌）。 */
    function titlebarHeight() {
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height');
        const value = Number.parseFloat(raw);
        if (Number.isFinite(value) && value >= 20 && value <= 80) return value;
      } catch {
        // 读不到令牌就用默认值。
      }
      return 40;
    }

    /**
     * 测量原生窗口按钮占用的宽度：WCO 给的标题条可用区域右边缘到窗口右边
     * 就是原生控件宽度。
     *
     * @returns 右侧要让出的 CSS 像素宽度。
     */
    function measureControlsWidth() {
      try {
        const overlay = navigator.windowControlsOverlay;
        const rect = overlay && typeof overlay.getTitlebarAreaRect === 'function' ? overlay.getTitlebarAreaRect() : null;
        if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.width) && rect.width > 0) {
          const gap = Math.round(window.innerWidth - (rect.x + rect.width));
          if (gap >= 0 && gap < 400) return gap;
        }
      } catch {
        // WCO 不可用时走兜底宽度。
      }
      return FALLBACK_CONTROLS_WIDTH;
    }

    /**
     * 计算按钮要让出的右侧宽度：从“紧贴原生窗口按钮左侧”开始，只要标题条
     * 中间那一格被别的元素占据（费用徽标、其它插件浮层…），就整体让到那个
     * 元素左边，直到那一格属于自己或祖先容器。
     *
     * @param node - 我们的座位元素；为 null 时只返回默认站位。
     * @returns 右侧偏移量（CSS 像素）。
     */
    function measureSeatRight(node) {
      let right = measureControlsWidth() + SEAT_GAP;
      if (node === null) return right;
      const viewport = window.innerWidth;
      const probeY = Math.min(titlebarHeight() / 2, Math.max(2, window.innerHeight / 2));
      for (let step = 0; step < MAX_SHIFT_STEPS; step += 1) {
        const probeX = viewport - right - BUTTON_SIZE / 2;
        if (probeX < 4) return right;
        let hit = null;
        try {
          hit = document.elementFromPoint(probeX, probeY);
        } catch {
          hit = null;
        }
        // 空白、自己、自己的后代、或祖先容器（含标题条拖拽层）都算“这一格是我的”。
        if (hit === null || hit === node || node.contains(hit) || hit.contains(node)) return right;
        const rect = hit.getBoundingClientRect();
        const next = Math.round(viewport - rect.left) + SEAT_GAP;
        if (!Number.isFinite(next) || next <= right + 1) return right;
        right = next;
      }
      return right;
    }

    /** 当前是否该渲染按钮（Windows 桌面外壳的标题条、且不在全屏）。 */
    function titlebarPresent() {
      const root = document.documentElement;
      return root.hasAttribute('data-windows-titlebar') && !root.hasAttribute('data-fullscreen');
    }

    /** 跟踪标题条是否存在：外壳只会在装载时写这两个属性。 */
    function useTitlebarPresence() {
      const [present, setPresent] = React.useState(titlebarPresent);
      React.useEffect(() => {
        const update = () => setPresent(titlebarPresent());
        update();
        const observer = new MutationObserver(update);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-windows-titlebar', 'data-fullscreen'] });
        return () => observer.disconnect();
      }, []);
      return present;
    }

    /** 置顶图标：顶部横条 + 向上箭头，实心横条表示已置顶。 */
    function PinIcon({ size = 17, filled = false }) {
      const stroke = {
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      };
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', style: { flex: 'none', display: 'block' } },
        h('rect', { x: 4.5, y: 3.75, width: 15, height: 2.5, rx: 1.25, fill: filled ? 'currentColor' : 'none', ...stroke }),
        h('path', { d: 'M12 20.25V9.25', ...stroke, fill: 'none' }),
        h('path', { d: 'M7.9 13.35 12 9.25l4.1 4.1', ...stroke, fill: 'none' }),
      );
    }

    /**
     * 标题栏置顶按钮：状态由宿主读取的真实窗口样式驱动。
     * `t` 由 owner 通过工厂闭包注入。
     */
    function WindowPinButton({ t }) {
      const present = useTitlebarPresence();
      const seatRef = React.useRef(null);
      const [right, setRight] = React.useState(() => measureSeatRight(null));
      const [busy, setBusy] = React.useState(false);
      const [state, setState] = React.useState({ phase: 'loading', pinned: false, supported: true, reason: '' });

      // 站位：挂载后先量一次，再在尺寸/几何变化、重新聚焦时重算，
      // 并低频复查（费用徽标这类邻居的宽度会随会话变化）。
      React.useLayoutEffect(() => {
        if (!present) return undefined;
        const update = () => setRight(measureSeatRight(seatRef.current));
        update();
        const timer = window.setInterval(update, 2000);
        const overlay = navigator.windowControlsOverlay;
        window.addEventListener('resize', update);
        window.addEventListener('focus', update);
        if (overlay && typeof overlay.addEventListener === 'function') overlay.addEventListener('geometrychange', update);
        return () => {
          window.clearInterval(timer);
          window.removeEventListener('resize', update);
          window.removeEventListener('focus', update);
          if (overlay && typeof overlay.removeEventListener === 'function') overlay.removeEventListener('geometrychange', update);
        };
      }, [present]);

      /** 读取宿主侧的真实状态；失败降级为可解释的禁用态。 */
      const sync = React.useCallback(async () => {
        try {
          const response = await fetch(STATE_ROUTE, { method: 'GET', headers: { accept: 'application/json' } });
          const payload = await response.json().catch(() => null);
          if (!response.ok) throw new Error((payload && (payload.reason || payload.error)) || `HTTP ${String(response.status)}`);
          if (payload === null || typeof payload !== 'object') throw new Error('invalid response');
          if (payload.supported === false) {
            setState({ phase: 'unsupported', pinned: false, supported: false, reason: payload.reason || '' });
            return;
          }
          if (payload.ok !== true) {
            setState({ phase: 'error', pinned: payload.pinned === true, supported: false, reason: payload.reason || '' });
            return;
          }
          setState({ phase: 'ready', pinned: payload.pinned === true, supported: true, reason: '' });
        } catch (cause) {
          setState({ phase: 'error', pinned: false, supported: false, reason: cause && cause.message ? String(cause.message) : String(cause) });
        }
      }, []);

      React.useEffect(() => {
        if (!present) return undefined;
        sync();
        const onFocus = () => { void sync(); };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onFocus);
        return () => {
          window.removeEventListener('focus', onFocus);
          document.removeEventListener('visibilitychange', onFocus);
        };
      }, [present, sync]);

      const toggle = React.useCallback(async () => {
        if (busy) return;
        setBusy(true);
        try {
          const response = await fetch(SET_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ pinned: state.pinned !== true }),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error((payload && (payload.reason || payload.error)) || `HTTP ${String(response.status)}`);
          }
          setState({ phase: 'ready', pinned: payload.pinned === true, supported: true, reason: '' });
        } catch (cause) {
          const message = cause && cause.message ? String(cause.message) : String(cause);
          setState((previous) => ({ ...previous, phase: 'error', supported: false, reason: message }));
        } finally {
          setBusy(false);
        }
      }, [busy, state.pinned]);

      if (!present) return null;

      const ready = state.phase === 'ready';
      const pinned = ready && state.pinned === true;
      const disabled = busy || !ready;
      const hint = state.phase === 'loading'
        ? t('loading')
        : state.phase === 'unsupported'
          ? `${t('unsupported')}${state.reason ? `（${state.reason}）` : ''}`
          : state.phase === 'error'
            ? `${t('failed')}${state.reason ? `：${state.reason}` : ''}`
            : busy
              ? t('applying')
              : pinned
                ? t('unpin')
                : t('pin');

      return h('div', { className: 'dwp-seat', ref: seatRef, 'data-dwp-version': String(CLIENT_VERSION), style: { right: `${String(right)}px` } },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'dwp-btn',
          onClick: toggle,
          disabled,
          title: hint,
          'aria-label': t('action'),
          'aria-pressed': pinned ? 'true' : 'false',
          'data-pinned': pinned ? 'true' : 'false',
          'data-busy': busy ? 'true' : 'false',
          'data-phase': state.phase,
        }, h(PinIcon, { size: 17, filled: pinned })),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'window-pin: locale dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'window-pin',
          order: 50,
          label: () => t('action'),
        }, (props) => h(WindowPinButton, { ...props, t }))), 'window-pin: titlebar pin button');
      },
    };
  },
});
