<div align="center">

<img src="docs/assets/readme/hero-zh.webp" alt="dsh-image-gen 中文功能概览" width="100%" />

<br />

<p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>

# 🎨 dsh-image-gen

### DeepSeek Harness 的原生 AI 图像创作套件

<p><b>对话生图与编辑 · Studio 批量创作 · 多模型对比 · 500+ Prompt 灵感 · 图库管理 · 本地 ComfyUI</b></p>

<p>
  <a href="https://www.npmjs.com/package/dsh-image-gen"><img src="https://img.shields.io/npm/v/dsh-image-gen?style=flat-square&color=4f6ef7" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/dsh-image-gen"><img src="https://img.shields.io/npm/dm/dsh-image-gen?style=flat-square&color=10b981" alt="npm downloads" /></a>
  <a href="https://github.com/shanliuling/dsh-image-gen/actions/workflows/ci.yml"><img src="https://github.com/shanliuling/dsh-image-gen/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/shanliuling/dsh-image-gen/stargazers"><img src="https://img.shields.io/github/stars/shanliuling/dsh-image-gen?style=flat-square" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f5c542?style=flat-square" alt="License: MIT" /></a>
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/LINUX%20DO-社区友链-555?style=flat-square" alt="LINUX DO" /></a>
</p>

<p>
  <a href="#快速开始">快速开始</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#provider-支持情况">Provider 支持</a> ·
  <a href="#常见问题">常见问题</a>
</p>

<br />

</div>

**为 DeepSeek Harness 带来完整的 AI 图像创作工作流。**

`dsh-image-gen` 不只是简单的对话生图，而是为 DSH 补齐了从**自然语言连续修图**、**Studio 批量创作**、**多模型横向对比**，到 **500+ Prompt 灵感库**与**本地 ComfyUI** 的全流程能力。支持 **Google Gemini、OpenAI Images / Compatible、ByteDance Seedream、Aliyun DashScope** 及本地私有化工作流，采用 BYOK（自带 Key）模式，生成结果支持按工作区隔离存储。

```bash
pnpm dsh plugin --profile web add dsh-image-gen@latest
```

> **版本更新提示：** 本次版本变化较大，老用户请更新至最新版本。

---

## 一个插件，四种创作方式

| 入口          | 最适合                    | 你可以做什么                                           |
| :------------ | :------------------------ | :----------------------------------------------------- |
| 💬 **对话**   | 让 Agent 理解自然语言需求 | 文生图、图生图、多图参考、连续编辑、原位重新生成       |
| 🎛️ **工作台** | 精确控制创作参数          | 1–4 张批量生成、最多 5 张参考图、缩放与拖拽画布        |
| ✨ **灵感**   | 找构图、风格与 Prompt     | 500+ 案例、搜索筛选、收藏、复制、一键带入工作台        |
| 🖼️ **图库**   | 整理与复用生成结果        | 搜索、筛选、收藏、重新生成、下载、批量管理、工作区隔离 |

---

## 快速开始

### 1. 安装插件

环境要求：DeepSeek Harness `>= 0.1.1-rc.2` 且 `< 0.2.0`，Node.js `^22.19.0` 或 `>= 24.0.0`。

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

**设置 → 插件 → 插件配置 → 图像生成**

选择 Provider，填写自己的 API Key，并按需调整模型、Endpoint / Base URL 与工作区保存选项。使用 ComfyUI 时，请填写 DSH Host 可访问的服务地址，并导入 **API Format Workflow JSON**。

<br />

<div align="center">
  <img src="docs/assets/readme/provider-settings.webp" alt="DSH 插件配置界面" width="100%" style="max-width: 680px; border-radius: 8px;" />
  <br />
  <sub>在设置面板中选择 Provider、配置 API Key、模型名称及工作区保存选项。</sub>
</div>

<br />

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
  <img src="docs/assets/readme/chat-example.webp" alt="对话生图与风格重构效果" width="100%" style="max-width: 840px; border-radius: 8px;" />
  <br />
  <sub>Agent 自动理解视觉意图并生成图片，结果直接呈现在当前会话流中。</sub>
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

### 🎛️ Studio 批量创作

- 支持最多 5 张参考图，一次生成 1–4 张候选图。
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
  <img src="docs/assets/readme/comfyui-workflows.webp" alt="ComfyUI 多工作流配置" width="760" />
  <br />
  <sub>为不同用途维护独立工作流，并通过名称让 Agent 精确选择。</sub>
</div>

<br />

---

## Provider 支持情况

| Provider                          | 对话生图 | 对话编辑 | Studio | 多模型对比 | Studio 参考图 |
| :-------------------------------- | :------: | :------: | :----: | :--------: | :-----------: |
| **Google Gemini**                 |    ✅    | ✅ 多图  |   ✅   |     ✅     |   最多 5 张   |
| **OpenAI Images / Compatible**    |    ✅    | ✅ 多图  |   ✅   |     ✅     |   最多 5 张   |
| **ByteDance Seedream / 火山方舟** |    ✅    | ✅ 多图  |   ✅   |     ✅     |   最多 5 张   |
| **Aliyun DashScope / Qwen Image** |    ✅    | ✅ 多图  |   ✅   |     ✅     |   最多 3 张   |
| **Local ComfyUI**                 |    ✅    | ✅ 单图  |   —    |     —      | 对话编辑 1 张 |

> Studio 与多模型对比目前只支持云端 Provider；多模型对比调用的是各 Provider 在设置中已配置的模型。

<details>
<summary><strong>当前默认模型与 Endpoint（均可修改）</strong></summary>

| Provider           | 默认模型                     | 默认 Endpoint / Base URL                                        |
| :----------------- | :--------------------------- | :-------------------------------------------------------------- |
| Google Gemini      | `gemini-3.1-flash-image`     | `https://generativelanguage.googleapis.com/v1beta/interactions` |
| OpenAI Images      | `gpt-image-2`                | `https://api.openai.com/v1`                                     |
| OpenAI Compatible  | 自定义                       | 自定义 Base URL                                                 |
| ByteDance Seedream | `doubao-seedream-5-0-260128` | `https://ark.cn-beijing.volces.com/api/v3`                      |
| Aliyun DashScope   | `qwen-image-3.0`             | `https://dashscope.aliyuncs.com/api/v1`                         |
| Local ComfyUI      | 用户导入的 API Workflow      | `http://127.0.0.1:8188`                                         |

</details>

---

## 数据与隐私

- **BYOK**：API Key 通过 DSH Credentials 服务保存，设置页不会回显 Key 明文。
- **云端请求**：Prompt 与本次使用的参考图会发送给所选 Provider，请遵守对应服务条款。
- **本地 ComfyUI**：请求发送到用户配置的 ComfyUI 地址。
- **工作区文件**：开启工作区保存后，对话结果会落盘；Studio 仅保存用户选中的候选图。
- **图库与收藏**：图库元数据和收藏状态保存在当前浏览器本地存储中。
- **灵感缓存**：案例元数据随插件提供，图片按需加载并缓存在本机，可随时清理。

## 常见问题

<details>
<summary><strong>安装后找不到“图像生成”设置怎么办？</strong></summary>

先完全重启当前 DSH Profile，再检查插件配置：

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

当前 Studio 与多模型对比只支持四类云端 Provider。ComfyUI 已支持在 Agent 对话中进行文生图、单图编辑以及多个命名工作流。

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
```

欢迎通过 [Issues](https://github.com/shanliuling/dsh-image-gen/issues) 反馈问题，或阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 后提交 Pull Request。

## License

本项目基于 [MIT License](LICENSE) 开源。

<div align="center">

如果 `dsh-image-gen` 对你的工作流有所帮助，欢迎在 GitHub 点亮一颗 ⭐ **Star** 支持持续维护。

**[查看 Releases](https://github.com/shanliuling/dsh-image-gen/releases) · [提交 Issue](https://github.com/shanliuling/dsh-image-gen/issues) · [参与贡献](CONTRIBUTING.md)**

</div>
