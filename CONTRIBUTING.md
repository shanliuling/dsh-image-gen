# Contributing

Bug reports should include the DSH version, Node version, selected image provider & model, and the complete redacted tool error. Never include an API key.

Before opening a pull request, run:

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run pack:check
```

Keep provider adapters in `src/google.ts` and `src/openai-compatible.ts`, shared constants in `src/shared.ts`, DSH registration in `src/index.ts`, and browser presentation in `src/client/index.tsx`.


## Maintainer notes

Saving settings on modern DSH requires the actually loaded `@deepseek-ai/schemastery >=3.18.4 <4`. The card distinguishes loading, missing host forms, remote connections that cannot persist, and incompatible schemas. Legacy DSH settings interfaces are retained. Check the dependencies resolved in the plugin profile when updating, as well as those in the source checkout.

`test:package` requires network access. It installs the current build's tarball and pinned published DSH 0.2 settings services in a temporary directory, then uses real React rendering to verify card state, the bundled save handler, profile file persistence, a fresh form, host restart, and actionable refusal with old schemastery. Image APIs, browser DOM, and RPC transport are outside this test. CI runs it on Windows and Linux.

### 维护者说明（中文）

新 DSH 的设置保存需要实际加载的 `@deepseek-ai/schemastery >=3.18.4 <4`。设置卡会区分加载中、宿主未提供设置、远程连接不可保存及依赖不兼容；旧 DSH 的设置接口仍保留。更新依赖时应检查插件所在 profile 的实际依赖，而不只检查源码目录。

`test:package` 需要网络，会在临时目录安装当前构建的插件 tarball 和指定版本的 DSH 0.2 设置服务，通过真实 React 渲染验证卡片状态和保存处理、配置文件写入、重新打开表单和宿主重启后的读取，并验证旧 schemastery 的明确拒绝提示。图片 API、浏览器 DOM 和 RPC 传输不属于此测试；CI 同时在 Windows 和 Linux 执行。
