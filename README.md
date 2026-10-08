<div align="center">

<img src="docs/assets/readme/hero-zh.webp" alt="dsh-image-gen 中文功能概览" width="100%" />

<br />

<p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>

# 🎨 dsh-image-gen

### DeepSeek Harness 的原生 AI 图像创作套件

<p><b>AI 创作画布 · 对话生图与编辑 · Studio 批量创作 · 多模型对比 · 500+ Prompt 灵感 · 图库管理 · 本地 ComfyUI · 订阅免 Key</b></p>

<p>
  <a href="https://www.npmjs.com/package/dsh-image-gen"><img src="https://img.shields.io/npm/v/dsh-image-gen?style=flat-square&color=4f6ef7" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/dsh-image-gen"><img src="https://img.shields.io/npm/dm/dsh-image-gen?style=flat-square&color=10b981" alt="npm downloads" /></a>
  <a href="https://github.com/shanliuling/dsh-image-gen/actions/workflows/ci.yml"><img src="https://github.com/shanliuling/dsh-image-gen/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://dsh-insights.com/p/shanliuling/dsh-image-gen"><img src="https://dsh-insights.com/badge/shanliuling/dsh-image-gen.svg" alt="DSH Insights health" /></a>
  <a href="https://github.com/shanliuling/dsh-image-gen/stargazers"><img src="https://img.shields.io/github/stars/shanliuling/dsh-image-gen?style=flat-square" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-f5c542?style=flat-square" alt="License: Apache-2.0" /></a>
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/LINUX%20DO-社区友链-555?style=flat-square" alt="LINUX DO" /></a>
</p>

<p>
  <a href="#快速开始">快速开始</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#provider-支持情况">Provider 支持</a> ·
  <a href="#常见问题">常见问题</a>
</p>

<br />

<img src="docs/assets/readme/canvas-generate.webp" alt="在无限画布中绘制草稿，并通过对话生成成图" width="46%" />
<img src="docs/assets/readme/canvas-edit.webp" alt="基于已有结果继续对话修改，在画布中持续迭代创作" width="46%" />
<br />
<sub>左：在画布中绘制草稿、摆放参考图，并通过对话生成成图。 · 右：基于已有结果继续对话修改，在画布中持续迭代创作。</sub>

<br />

<img src="docs/assets/readme/chat-generate.webp" alt="在对话中直接描述并生成图片" width="46%" />
<img src="docs/assets/readme/other-features.webp" alt="工作台批量创作、灵感库与图库等更多功能" width="46%" />
<br />
<sub>左：在对话中直接描述并生成图片。 · 右：工作台批量创作、灵感库与图库等更多功能。</sub>

</div>

**为 DeepSeek Harness 带来完整的 AI 图像创作工作流。**

`dsh-image-gen` 不只是简单的对话生图，而是为 DSH 补齐从 **对话生成与连续修图**、**AI 创作画布**、**Studio 批量创作**、**多模型横向对比**，到 **Prompt 灵感库** 与 **本地 ComfyUI** 的完整图像创作能力。

支持主流云端图像模型与本地私有化工作流，既可使用 BYOK（自带 Key），也支持通过订阅账号直接使用，生成结果支持按工作区隔离存储。

> **已有 ChatGPT、Grok 或 Google 订阅？直接登录即可生图，无需额外购买 API Key。**

支持：Gemini · OpenAI / Compatible · Seedream · DashScope · Grok Imagine · GLM-Image · 本地 ComfyUI

```bash
pnpm dsh plugin --profile web add dsh-image-gen@latest
```

> **版本更新提示：** 本次版本变化较大，老用户请更新至最新版本。

<img src="docs/assets/readme/workflow-overview.webp" alt="dsh-image-gen 完整 AI 图像创作工作流" width="100%" />

---

## 一个插件，覆盖完整 AI 图像创作流程

| 入口          | 最适合           | 你可以做什么                             |
| :------------ | :--------------- | :--------------------------------------- |
| 💬 **对话**   | 快速表达想法     | 文生图、图生图、连续编辑、版本迭代       |
| ✏️ **画布**   | 表达视觉创意     | 草稿生成、参考图组合、空间创作、持续修改 |
| 🎛️ **工作台** | 精细控制创作参数 | 批量生成、多图参考、高级参数调整         |
| ✨ **灵感**   | 寻找创作方向     | Prompt 案例、风格探索、一键复用          |
| 🖼️ **图库**   | 管理生成结果     | 搜索、收藏、下载、重新使用               |

---

## 快速开始

### 1. 安装插件

环境要求：DeepSeek Harness 稳定版本，Node.js `^22.19.0` 或 `>= 24.0.0`。

在你的 DeepSeek Harness 项目根目录下运行：

```bash
pnpm dsh plugin --profile web add dsh-image-gen@latest
```

> 💬 **极客提示**：你也可以直接把这句话发送给 DSH 对话中的 Agent：<br />
> `帮我安装生图插件，在终端执行：pnpm dsh plugin --profile web add dsh-image-gen@latest`

<details>
<summary><strong>其他安装方式（全局 / GitHub 直装 / 本地调试）</strong></summary>

```bash
# 若已将 dsh 安装为系统全局命令：
dsh plugin --profile web add dsh-image-gen@latest

# 从 GitHub 仓库直接安装最新代码：
pnpm dsh plugin --profile web add git+https://github.com/shanliuling/dsh-image-gen.git

# 本地克隆源码开发安装：
git clone https://github.com/shanliuling/dsh-image-gen.git
pnpm dsh plugin --profile web add ./dsh-image-gen
```

</details>

### 2. 配置 Provider

重启 DSH 后进入：

**设置 → 插件 → 图像生成**

> DSH 0.1.5 及更早版本的入口为「设置 → 插件 → 插件配置 → 图像生成」，插件已同时兼容两种入口。

选择 Provider，填写自己的 API Key，并按需调整模型、Endpoint / Base URL 与工作区保存选项。填好 Key 后可点击**「测试连接」**验证可用性，或点击**「拉取模型」**一键获取该厂商支持的全部生图模型，无需手动查文档。使用 ComfyUI 时，请填写 DSH Host 可访问的服务地址，并导入 **API Format Workflow JSON**。

已有 ChatGPT、Grok 或 Google 订阅？无需填写 API Key：展开对应的订阅 Provider 行，点击**「登录」**并在浏览器完成授权，即可直接开始文生图与图生图。

### 3. 开始创作

在聊天框中直接描述你想要的图片：

```text
画一张雨夜霓虹街头的赛博朋克猫咪，电影感光线，16:9。
```

也可以直接上传参考图，让 Agent 进行风格重构或局部编辑：

```text
保持角色与构图不变，给猫咪戴上一副黑色墨镜。
```

<br />

<div align="center">
  <img src="docs/assets/readme/provider-settings.webp" alt="DSH 插件配置界面" width="46%" />
  <img src="docs/assets/readme/chat-example.webp" alt="对话生图与风格重构效果" width="46%" />
  <br />
  <sub>左：Provider 配置 · 右：在 DSH 对话中直接生图、图生图与连续编辑。</sub>
</div>

<br />

需要更细的参数控制时，点击会话顶部的 **画廊** 入口，进入 **图库 / 工作台 / 灵感 / 收藏**。

---

## 核心能力

### 💬 对话生图、编辑与版本切换

- 用自然语言完成文生图、图生图、多图参考和风格迁移。
- 直接修改原图 Prompt 重新生成，并在同一卡片中切换历史版本。

<br />

<div align="center">
  <img src="docs/assets/readme/regenerating.webp" alt="图片正在重新生成" width="46%" />
  <img src="docs/assets/readme/revision-switcher.webp" alt="在同一图片卡片中切换生成版本" width="46%" />
  <br />
  <sub>修改 Prompt 后原位重新生成，并在同一张图片卡片中切换历史版本。</sub>
</div>

<br />

### ✏️ 从草稿到成图：AI 创作画布

在无限画布中表达你的创意，通过对话将草稿、构图和想法转化为真实图片。

- 在画布中自由绘制草稿、添加参考素材并组织创意。
- 通过自然语言与 AI 对话，让草稿快速变成完整作品。
- 基于已有结果持续编辑、修改和生成新的方向，保留创作过程，让每一次探索都可以继续迭代。

<br />

<div align="center">
  <img src="docs/assets/readme/canvas-generate.webp" alt="在无限画布中绘制草稿，并通过对话生成成图" width="46%" />
  <img src="docs/assets/readme/canvas-edit.webp" alt="基于已有结果继续对话修改，在画布中持续迭代创作" width="46%" />
  <br />
  <sub>左：在画布中绘制草稿、摆放参考图，并通过对话生成成图。 · 右：基于已有结果继续对话修改，在画布中持续迭代创作。</sub>
</div>

<br />

### 🎛️ Studio 批量创作

- 支持多张参考图，一次生成多张候选图。
- 自由控制 Provider、模型、比例和清晰度，只保存满意的结果。

<br />

<div align="center">
  <img src="docs/assets/readme/studio-workbench.webp" alt="dsh-image-gen Studio 工作台" width="100%" />
  <br />
  <sub>在同一个 Studio 中完成参考图导入、参数控制、批量生成、结果筛选与保存。</sub>
</div>

<br />

### ⚖️ 多模型横向对比

使用同一组 Prompt 和参考图并发调用多个模型，在一张画布中比较并保存结果。

<br />

<div align="center">
  <img src="docs/assets/readme/multi-model-compare.webp" alt="同一 Prompt 的多模型生成对比" width="100%" />
  <br />
  <sub>在同一画布中比较不同模型结果，再批量保存满意的图片。</sub>
</div>

<br />

### ✨ 500+ Prompt 灵感案例

- 浏览和筛选 **500+ Prompt 案例**，支持收藏、复制及一键带入 Studio。
- 图片缓存在本地，浏览和学习不消耗 Token 或生成额度。

<br />

<div align="center">
  <img src="docs/assets/readme/inspiration-library.webp" alt="Prompt 灵感素材库" width="100%" />
  <br />
  <sub>先找灵感，再把 Prompt 带入工作台；全本地缓存，浏览或复制不消耗生成额度。</sub>
</div>

<br />

### 🖼️ 图库、收藏与批量管理

- 统一管理对话和 Studio 中保存的图片，并按工作区隔离。
- 支持搜索、筛选、收藏、下载、继续编辑、重新生成和批量管理。

<br />

<div align="center">
  <img src="docs/assets/readme/gallery-management.webp" alt="图库筛选、收藏与批量管理" width="100%" />
  <br />
  <sub>图库支持多维度筛选、收藏、批量管理与工作区数据隔离。</sub>
</div>

<br />

### 🧩 本地 ComfyUI 多工作流

灵活调用本地 GPU 算力，让私有化绘图无缝融入 Agent 对话。

- 导入并管理多个命名工作流，支持预设 Prompt 和常用占位符。
- Agent 可按名称选择工作流，在对话中完成文生图和图生图。

> ComfyUI 暂未接入 Studio 和多模型对比。

<br />

<div align="center">
  <img src="docs/assets/readme/comfyui-workflows.webp" alt="ComfyUI 多工作流配置" width="58%" />
  <br />
  <sub>为不同用途维护独立工作流，并通过名称让 Agent 精确选择。</sub>
</div>

<br />

---

## Provider 支持情况

| Provider                          | 对话生图 | 对话编辑 | Studio | 多模型对比 |
| :-------------------------------- | :------: | :------: | :----: | :--------: |
| **Google Gemini**                 |    ✅    | ✅ 多图  |   ✅   |     ✅     |
| **OpenAI Images**                 |    ✅    | ✅ 多图  |   ✅   |     ✅     |
| **OpenAI Compatible（中转站）**   |    ✅    | ✅ 多图  |   ✅   |     ✅     |
| **ByteDance Seedream / 火山方舟** |    ✅    | ✅ 多图  |   ✅   |     ✅     |
| **Aliyun DashScope / Qwen Image** |    ✅    | ✅ 多图  |   ✅   |     ✅     |
| **xAI Grok Imagine**              |    ✅    | ⚠️ 有限  |   ✅   |     ✅     |
| **智谱 GLM-Image**                |    ✅    |    —     |   ✅   |     ✅     |
| **Local ComfyUI**                 |    ✅    | ✅ 单图  |   —    |     —      |
| **ChatGPT 订阅（免 Key）**       |    ✅    | ✅ 多图  |   ✅   |     ✅     |
| **Grok 订阅（免 Key）**          |    ✅    | ✅ 多图  |   ✅   |     ✅     |
| **Google 订阅（免 Key）**        |    ✅    | ✅ 多图  |   ✅   |     ✅     |

> Studio 与多模型对比目前只支持云端 Provider（含订阅通道）；多模型对比调用的是各 Provider 在设置中已配置的模型。
> 智谱 GLM-Image 上游本身不支持图生图；xAI 图生图走 OpenAI 兼容协议（multipart），部分网关可能需等待后续适配。
> 订阅通道通过账号登录使用（免 API Key），支持对话文生图 / 图生图、Studio 批量生成与多模型对比；图生图走各订阅渠道的编辑接口（最多 5 张参考图），比例与清晰度可在 Studio 中直接选择。

<details>
<summary><strong>当前默认模型与 Endpoint（均可修改）</strong></summary>

| Provider           | 默认模型                     | 默认 Endpoint / Base URL                                        |
| :----------------- | :--------------------------- | :-------------------------------------------------------------- |
| Google Gemini      | `gemini-3.1-flash-image`     | `https://generativelanguage.googleapis.com/v1beta/interactions` |
| OpenAI Images      | `gpt-image-2`                | `https://api.openai.com/v1`                                     |
| OpenAI Compatible  | 自定义                       | 自定义 Base URL                                                 |
| ByteDance Seedream | `doubao-seedream-5-0-260128` | `https://ark.cn-beijing.volces.com/api/v3`                      |
| Aliyun DashScope   | `qwen-image-3.0`             | `https://dashscope.aliyuncs.com/api/v1`                         |
| xAI Grok Imagine   | `grok-imagine-image`         | `https://api.x.ai/v1`                                           |
| 智谱 GLM-Image     | `glm-image`                  | `https://open.bigmodel.cn/api/paas/v4`                         |
| Local ComfyUI      | 用户导入的 API Workflow      | `http://127.0.0.1:8188`                                         |
| ChatGPT 订阅       | `gpt-image-2.5-flare`（通道固定） | 账号登录，无需配置                                        |
| Grok 订阅         | `grok-imagine-image-2.0`（通道固定） | 账号登录，无需配置                                    |
| Google 订阅       | `gemini-3.1-flash-image`（通道固定） | 账号登录，无需配置                                        |

</details>

<details>
<summary><strong>各 Provider 可选比例与清晰度</strong></summary>

| Provider           | 比例                                                              | 清晰度                                  |
| :----------------- | :---------------------------------------------------------------- | :-------------------------------------- |
| Google Gemini      | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 4:5 · 5:4 · 16:9 · 9:16 · 21:9      | 1K / 2K / 4K                            |
| OpenAI Images      | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16                         | 自动 / low / medium / high              |
| OpenAI Compatible  | 由 `openaiCompatSizes` 配置决定（默认 1:1 · 3:2 · 2:3）           | 同上（默认 standard）                   |
| ByteDance Seedream | 自动 · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9           | 2K / 3K / 4K                            |
| Aliyun DashScope   | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16                         | 标准                                    |
| xAI Grok Imagine   | 自动 · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9           | 1K / 2K                                 |
| 智谱 GLM-Image     | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16                         | 高清                                    |
| ChatGPT 订阅       | 自动 · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16                  | 自动 / low / medium / high / xhigh / max |
| Grok 订阅          | 自动 · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9           | 1K / 2K                                 |
| Google 订阅        | 自动 · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 4:5 · 5:4 · 16:9 · 9:16 · 21:9 | 标准 / 高清（4K）                     |

> 「自动」比例表示由模型按 Prompt 自行决定构图；上游已移除的档位（如 Seedream 5.0 的 1K）插件不会暴露。
> OpenAI Compatible（中转站）的比例与清晰度由设置中的 `openaiCompatSizes` 表驱动，格式为「比例 → 档位 → 像素」，例如 `{ "16:9": { "2K": "2048x1152" } }`；留空时保持 1:1 / 3:2 / 2:3 + standard 的兼容行为。

</details>

---

## 数据与隐私

- **BYOK**：API Key 通过 DSH Credentials 服务保存，设置页不会回显 Key 明文。
- **订阅登录**：订阅账号令牌经你授权登录后保存于 DSH Credentials，与 API Key 完全隔离，浏览器侧不接触令牌。
- **云端请求**：Prompt 与本次使用的参考图会发送给所选 Provider，请遵守对应服务条款。
- **本地 ComfyUI**：请求发送到用户配置的 ComfyUI 地址。
- **工作区文件**：开启工作区保存后，对话结果会落盘；Studio 仅保存用户选中的候选图。
- **图库与收藏**：图库元数据和收藏状态保存在当前浏览器本地存储中。
- **灵感缓存**：案例元数据随插件提供，图片按需加载并缓存在本机，可随时清理。

## 常见问题

<details>
<summary><strong>安装后找不到“图像生成”设置怎么办？</strong></summary>

设置入口随 DSH 版本不同：0.1.6 及以上位于「设置 → 插件 → 图像生成」，0.1.5 及更早位于「设置 → 插件 → 插件配置 → 图像生成」。

若两处都没有，先完全重启当前 DSH Profile，再检查插件配置：

```bash
dsh --profile web --dump-config
```

如果输出中没有 `dsh-image-gen`，请重新执行安装命令。提交 Issue 时请附 DSH 版本、插件版本和错误日志，不要上传 API Key。

</details>

<details>
<summary><strong>生成图片保存在哪里？</strong></summary>

开启“保存到工作区”后，对话生成结果默认保存在当前工作区的 `dsh-image-gen/` 子目录，也可以在设置中修改。Studio 候选图先留在临时画布，只有用户选中的结果才会进入图库并保存。

</details>

<details>
<summary><strong>为什么 ComfyUI 没有出现在 Studio 中？</strong></summary>

当前 Studio 与多模型对比仅支持云端 Provider，暂未接入 ComfyUI。ComfyUI 已支持在 Agent 对话中进行文生图、单图编辑以及多个命名工作流。

</details>

<details>
<summary><strong>从图库删除会删除聊天记录吗？</strong></summary>

不会。删除图库记录不会修改原聊天消息。你可以额外选择是否清理工作区中的本地图片文件；文件删除通常无法恢复，请确认后操作。

</details>

<details>
<summary><strong>如何升级？</strong></summary>

```bash
pnpm dsh plugin --profile web add dsh-image-gen@latest
```

升级后重启对应的 DSH Profile。

</details>

---

## 本地开发

```bash
git clone https://github.com/shanliuling/dsh-image-gen.git
cd dsh-image-gen

pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run pack:check
pnpm run test:package
```

新 DSH 的设置保存需要实际加载的 `@deepseek-ai/schemastery >=3.18.4 <4`。设置卡会区分加载中、宿主未提供设置、远程连接不可保存及依赖不兼容；旧 DSH 的设置接口仍保留。更新依赖时应检查插件所在 profile 的实际依赖，而不只检查源码目录。

`test:package` 需要网络，会在临时目录安装当前构建的插件 tarball 和指定版本的 DSH 0.2 设置服务，通过真实 React 渲染验证卡片状态和保存处理、配置文件写入、重新打开表单和宿主重启后的读取，并验证旧 schemastery 的明确拒绝提示。图片 API、浏览器 DOM 和 RPC 传输不属于此测试；CI 同时在 Windows 和 Linux 执行。

欢迎通过 [Issues](https://github.com/shanliuling/dsh-image-gen/issues) 反馈问题，或阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 后提交 Pull Request。

## License

本项目基于 [Apache License 2.0](LICENSE) 开源。

<div align="center">

如果 `dsh-image-gen` 对你的工作流有所帮助，欢迎在 GitHub 点亮一颗 ⭐ **Star** 支持持续维护。

**[查看 Releases](https://github.com/shanliuling/dsh-image-gen/releases) · [提交 Issue](https://github.com/shanliuling/dsh-image-gen/issues) · [参与贡献](CONTRIBUTING.md)**

</div>
