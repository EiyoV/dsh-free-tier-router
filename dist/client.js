/**
 * dsh-free-tier-router —— client 侧（在「设置」里注册一个独立选项面板）。
 *
 * 面板本体是 Host 提供的 /llm-router 页面，这里用 iframe 嵌进来。
 * 这样管理界面只有一份实现：不必用 React 重写一遍表格、按钮和目录渲染，
 * 也避免绑定 DSH 前端的内部组件结构（那东西一变就坏）。
 *
 * 结构照抄官方 client 插件的约定：
 *   - 入口是一个 IIFE，最后调用 window.__ModuleLoader__.load({id, factory})
 *   - factory(require) 里 require("react")，由宿主注入
 *   - 返回 { apply, inject }
 */
(function () {
  let injected = null;
  function provideReact(react) {
    injected = react;
  }
  function getReact() {
    if (!injected) throw new Error('[dsh-free-tier-router] React 尚未注入：entry 需先调用 provideReact()');
    return injected;
  }

  const NS = 'dsh-free-tier-router';
  const zh = { tab: '渠道池', title: 'llm-router 渠道池' };
  const en = { tab: 'LLM Router', title: 'llm-router channel pool' };

  const inject = ['slots', 'locale'];

  function apply(ctx) {
    const React = getReact();

    ctx.effect(
      () => ctx.locale.register(NS, { zh, en }),
      'dsh-free-tier-router: dictionaries'
    );
    const t = ctx.locale.bind(NS);

    function RouterPanel() {
      return React.createElement('iframe', {
        src: '/llm-router',
        title: t('title'),
        style: {
          width: '100%',
          height: 'calc(100vh - 180px)',
          minHeight: '520px',
          border: 'none',
          borderRadius: '8px',
          background: 'transparent',
          display: 'block',
        },
      });
    }

    ctx.effect(
      () =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'llm-router',
              order: 55,
              label: () => t('tab'),
              locale: NS,
            },
            () => React.createElement(RouterPanel)
          )
        ),
      'dsh-free-tier-router: settings section'
    );
  }

  window.__ModuleLoader__.load({
    id: 'dsh-free-tier-router',
    factory: (require) => {
      provideReact(require('react'));
      return { apply, inject };
    },
  });
})();
