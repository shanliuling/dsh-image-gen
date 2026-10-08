<div align="center">

<img src="docs/assets/readme/hero-en.webp" alt="dsh-image-gen feature overview" width="100%" />

<br />

<p><a href="README.md">简体中文</a> · <strong>English</strong></p>

# 🎨 dsh-image-gen

### Native AI image creation suite for DeepSeek Harness

<p><b>AI Creative Canvas · In-chat generation and editing · Studio batch creation · Multi-model comparison · 500+ prompt inspirations · Gallery management · Local ComfyUI · Subscription no-key</b></p>

<p>
  <a href="https://www.npmjs.com/package/dsh-image-gen"><img src="https://img.shields.io/npm/v/dsh-image-gen?style=flat-square&color=4f6ef7" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/dsh-image-gen"><img src="https://img.shields.io/npm/dm/dsh-image-gen?style=flat-square&color=10b981" alt="npm downloads" /></a>
  <a href="https://github.com/shanliuling/dsh-image-gen/actions/workflows/ci.yml"><img src="https://github.com/shanliuling/dsh-image-gen/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://dsh-insights.com/p/shanliuling/dsh-image-gen"><img src="https://dsh-insights.com/badge/shanliuling/dsh-image-gen.svg" alt="DSH Insights health" /></a>
  <a href="https://github.com/shanliuling/dsh-image-gen/stargazers"><img src="https://img.shields.io/github/stars/shanliuling/dsh-image-gen?style=flat-square" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-f5c542?style=flat-square" alt="License: Apache-2.0" /></a>
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/LINUX%20DO-Community-555?style=flat-square" alt="LINUX DO" /></a>
</p>

<p>
  <a href="#quick-start">Quick Start</a> ·
  <a href="#core-capabilities">Core Capabilities</a> ·
  <a href="#provider-support">Provider Support</a> ·
  <a href="#faq">FAQ</a>
</p>

<br />

<img src="docs/assets/readme/canvas-generate.webp" alt="Sketching on the infinite canvas and generating a final image through conversation" width="46%" />
<img src="docs/assets/readme/canvas-edit.webp" alt="Continuing to edit and iterate through conversation based on existing results" width="46%" />
<br />
<sub>Left: Sketch and place reference images on the canvas, then generate through conversation. · Right: Keep iterating on existing results through conversation.</sub>

<br />

<img src="docs/assets/readme/chat-generate.webp" alt="Generating images directly in conversation" width="46%" />
<img src="docs/assets/readme/other-features.webp" alt="Studio batch creation, inspiration library, gallery and more" width="46%" />
<br />
<sub>Left: Describe and generate images right in the conversation. · Right: Studio batch creation, inspiration library, gallery, and more.</sub>

</div>

**A complete AI image creation workflow for DeepSeek Harness.**

`dsh-image-gen` goes far beyond basic in-chat image generation. It brings **in-chat generation with continuous editing**, an **AI creative canvas**, **Studio batch creation**, **side-by-side multi-model comparison**, a **prompt inspiration library**, and **local ComfyUI** workflows into DSH.

It supports mainstream cloud image models and private local workflows, works with BYOK (bring your own key) or subscription accounts, and can isolate generated assets by workspace.

> **Already paying for ChatGPT, Grok, or Google? Just sign in and start generating—no separate API key purchase needed.**

Supports: Gemini · OpenAI / Compatible · Seedream · DashScope · Grok Imagine · GLM-Image · Local ComfyUI

```bash
pnpm dsh plugin --profile web add dsh-image-gen@latest
```

> **Update notice:** This release includes major changes. Existing users should update to the latest version.

<img src="docs/assets/readme/workflow-overview-en.webp" alt="dsh-image-gen complete AI image creation workflow" width="100%" />

---

## One plugin, the complete AI image creation workflow

| Entry | Best for | What you can do |
| :--- | :--- | :--- |
| 💬 **Chat** | Expressing ideas quickly | Text-to-image, image-to-image, continuous editing, and revision iteration |
| ✏️ **Canvas** | Expressing visual creativity | Sketch-to-image, reference composition, spatial creation, and continuous refinement |
| 🎛️ **Studio** | Fine-grained control over creation parameters | Batch generation, multi-image reference, and advanced parameter tuning |
| ✨ **Inspiration** | Finding creative direction | Prompt examples, style exploration, and one-click reuse |
| 🖼️ **Gallery** | Managing generated results | Search, favorite, download, and reuse |

---

## Quick Start

### 1. Install the plugin

Requirements: DeepSeek Harness stable version, Node.js `^22.19.0` or `>= 24.0.0`.

Run this command from your DeepSeek Harness project root:

```bash
pnpm dsh plugin --profile web add dsh-image-gen@latest
```

> 💬 **Power-user tip:** You can also send this directly to the Agent in a DSH chat:<br />
> `Install the image generation plugin by running this command in the terminal: pnpm dsh plugin --profile web add dsh-image-gen@latest`

<details>
<summary><strong>Alternative installation methods (global / GitHub / local development)</strong></summary>

```bash
# If dsh is installed globally:
dsh plugin --profile web add dsh-image-gen@latest

# Install the latest source directly from GitHub:
pnpm dsh plugin --profile web add git+https://github.com/shanliuling/dsh-image-gen.git

# Clone the repository and install it for local development:
git clone https://github.com/shanliuling/dsh-image-gen.git
pnpm dsh plugin --profile web add ./dsh-image-gen
```

</details>

### 2. Configure a Provider

After restarting DSH, open:

**Settings → Plugins → Image Generation**

> On DSH 0.1.5 and earlier the entry is **Settings → Plugins → Plugin Configuration → Image Generation**; the same plugin build supports both.

Choose a Provider, enter your API key, and adjust the model, Endpoint / Base URL, and workspace-save options as needed. Once the key is stored, click **Test connection** to verify it, or **Fetch models** to pull every image-capable model the provider offers—no manual lookups needed. For ComfyUI, enter an address reachable by the DSH Host and import an **API Format Workflow JSON** file.

Already paying for ChatGPT, Grok, or Google? No API key needed: expand the matching subscription Provider row, click **Sign in** and complete the authorization in your browser, then start generating (and editing) right away.

### 3. Start creating

Describe the image you want directly in chat:

```text
Create a cinematic cyberpunk cat on a neon street at night, 16:9.
```

You can also upload a reference image directly for style transfer or editing:

```text
Keep the character and composition unchanged, then add black sunglasses to the cat.
```

<br />

<div align="center">
  <img src="docs/assets/readme/provider-settings.webp" alt="DSH Plugin Settings" width="46%" />
  <img src="docs/assets/readme/chat-example.webp" alt="Chat generation and editing example" width="46%" />
  <br />
  <sub>Left: Provider Settings · Right: In-chat generation, editing, and continuous refinement.</sub>
</div>

<br />

For more precise parameter control, open **Gallery** from the conversation header, then switch between **Gallery / Studio / Inspiration / Favorites**.

---

## Core Capabilities

### 💬 In-chat generation, editing, and revision switching

- Use natural language for text-to-image, image-to-image, multi-image reference, and style transfer.
- Edit the original prompt to regenerate, then switch between revisions on the same image card.

<br />

<div align="center">
  <img src="docs/assets/readme/regenerating.webp" alt="Image regeneration in progress" width="46%" />
  <img src="docs/assets/readme/revision-switcher.webp" alt="Switching between generated revisions on the same image card" width="46%" />
  <br />
  <sub>Regenerate in place after editing the prompt, then switch between previous results on the same image card.</sub>
</div>

<br />

### ✏️ From sketch to image: AI creative canvas

Express your ideas on an infinite canvas and turn drafts, compositions, and thoughts into real images through conversation.

- Freely sketch, add reference materials, and organize your ideas on the canvas.
- Talk to the AI in natural language to turn a draft into a finished piece.
- Keep editing, refining, and exploring new directions from existing results—your creative process is preserved so every exploration stays iterable.

<br />

<div align="center">
  <img src="docs/assets/readme/canvas-generate.webp" alt="Sketching on the infinite canvas and generating a final image through conversation" width="46%" />
  <img src="docs/assets/readme/canvas-edit.webp" alt="Continuing to edit and iterate through conversation based on existing results" width="46%" />
  <br />
  <sub>Left: Sketch and place reference images on the canvas, then generate through conversation. · Right: Keep iterating on existing results through conversation.</sub>
</div>

<br />

### 🎛️ Studio batch creation

- Support multiple reference images, and generate multiple candidates at a time.
- Control the Provider, model, aspect ratio, and quality, then save only the results you want.

<br />

<div align="center">
  <img src="docs/assets/readme/studio-workbench.webp" alt="dsh-image-gen Studio workbench" width="100%" />
  <br />
  <sub>Import references, control parameters, generate batches, select results, and save—all within one Studio.</sub>
</div>

<br />

### ⚖️ Side-by-side multi-model comparison

Run the same prompt and reference images across multiple models, then compare and save the results on one canvas.

<br />

<div align="center">
  <img src="docs/assets/readme/multi-model-compare.webp" alt="Comparing the same prompt across multiple image models" width="100%" />
  <br />
  <sub>Compare results from different models on one canvas, then save the images you prefer in a batch.</sub>
</div>

<br />

### ✨ 500+ prompt inspiration examples

- Browse and filter **500+ prompt examples**, then favorite, copy, or send them directly to Studio.
- Images are cached locally, so browsing and learning consume no tokens or generation quota.

<br />

<div align="center">
  <img src="docs/assets/readme/inspiration-library.webp" alt="Prompt inspiration library" width="100%" />
  <br />
  <sub>Find inspiration first, then send a prompt to Studio. Browsing and copying from the local cache consume no generation quota.</sub>
</div>

<br />

### 🖼️ Gallery, favorites, and batch management

- Manage images saved from chat and Studio in one place, isolated by workspace.
- Search, filter, favorite, download, continue editing, regenerate, and batch-manage results.

<br />

<div align="center">
  <img src="docs/assets/readme/gallery-management.webp" alt="Gallery filtering, favorites, and batch management" width="100%" />
  <br />
  <sub>Filter, favorite, and batch-manage gallery items while keeping data isolated by workspace.</sub>
</div>

<br />

### 🧩 Multiple local ComfyUI workflows

Bring private image generation on your local GPU directly into Agent conversations.

- Import and manage multiple named workflows with prompt presets and common placeholders.
- Let the Agent select a workflow by name for text-to-image or image-to-image generation in chat.

> ComfyUI is not yet integrated into Studio or multi-model comparison.

<br />

<div align="center">
  <img src="docs/assets/readme/comfyui-workflows.webp" alt="Multiple named ComfyUI workflow settings" width="58%" />
  <br />
  <sub>Maintain independent workflows for different tasks and let the Agent select them precisely by name.</sub>
</div>

<br />

---

## Provider Support

| Provider | Chat generation | Chat editing | Studio | Multi-model comparison |
| :--- | :---: | :---: | :---: | :---: |
| **Google Gemini** | ✅ | ✅ Multiple | ✅ | ✅ |
| **OpenAI Images** | ✅ | ✅ Multiple | ✅ | ✅ |
| **OpenAI Compatible (relay)** | ✅ | ✅ Multiple | ✅ | ✅ |
| **ByteDance Seedream / Volcengine Ark** | ✅ | ✅ Multiple | ✅ | ✅ |
| **Aliyun DashScope / Qwen Image** | ✅ | ✅ Multiple | ✅ | ✅ |
| **xAI Grok Imagine** | ✅ | ⚠️ Limited | ✅ | ✅ |
| **Zhipu GLM-Image** | ✅ | — | ✅ | ✅ |
| **Local ComfyUI** | ✅ | ✅ Single | — | — |
| **ChatGPT subscription (key-free)** | ✅ | ✅ Multiple | ✅ | ✅ |
| **Grok subscription (key-free)** | ✅ | ✅ Multiple | ✅ | ✅ |
| **Google subscription (key-free)** | ✅ | ✅ Multiple | ✅ | ✅ |

> Studio and multi-model comparison currently support cloud Providers only (subscription channels included). Multi-model comparison uses the model configured for each Provider in Settings.
> Zhipu GLM-Image does not support image-to-image upstream. xAI image editing goes through the OpenAI-compatible protocol (multipart); some gateways may need further adaptation.
> Subscription channels work through account sign-in (no API key). They support in-chat text-to-image / image-to-image, Studio batch generation, and multi-model comparison; edits ride each channel's edit endpoint (up to 5 reference images), with aspect ratio and quality selectable directly in Studio.

<details>
<summary><strong>Current default models and endpoints (all configurable)</strong></summary>

| Provider | Default model | Default Endpoint / Base URL |
| :--- | :--- | :--- |
| Google Gemini | `gemini-3.1-flash-image` | `https://generativelanguage.googleapis.com/v1beta/interactions` |
| OpenAI Images | `gpt-image-2` | `https://api.openai.com/v1` |
| OpenAI Compatible | Custom | Custom Base URL |
| ByteDance Seedream | `doubao-seedream-5-0-260128` | `https://ark.cn-beijing.volces.com/api/v3` |
| Aliyun DashScope | `qwen-image-3.0` | `https://dashscope.aliyuncs.com/api/v1` |
| xAI Grok Imagine | `grok-imagine-image` | `https://api.x.ai/v1` |
| Zhipu GLM-Image | `glm-image` | `https://open.bigmodel.cn/api/paas/v4` |
| Local ComfyUI | Imported API Workflow | `http://127.0.0.1:8188` |
| ChatGPT subscription | `gpt-image-2.5-flare` (channel-fixed) | Account sign-in, no configuration |
| Grok subscription | `grok-imagine-image-2.0` (channel-fixed) | Account sign-in, no configuration |
| Google subscription | `gemini-3.1-flash-image` (channel-fixed) | Account sign-in, no configuration |

</details>

<details>
<summary><strong>Aspect ratios and quality tiers per Provider</strong></summary>

| Provider | Aspect ratios | Quality tiers |
| :--- | :--- | :--- |
| Google Gemini | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 4:5 · 5:4 · 16:9 · 9:16 · 21:9 | 1K / 2K / 4K |
| OpenAI Images | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 | auto / low / medium / high |
| OpenAI Compatible | Driven by `openaiCompatSizes` (default 1:1 · 3:2 · 2:3) | Same table (default standard) |
| ByteDance Seedream | auto · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9 | 2K / 3K / 4K |
| Aliyun DashScope | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 | standard |
| xAI Grok Imagine | auto · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9 | 1K / 2K |
| Zhipu GLM-Image | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 | hd |
| ChatGPT subscription | auto · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 | auto / low / medium / high / xhigh / max |
| Grok subscription | auto · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9 | 1K / 2K |
| Google subscription | auto · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 4:5 · 5:4 · 16:9 · 9:16 · 21:9 | standard / HD (4K) |

> An `auto` ratio lets the model pick the framing from the prompt; tiers the upstream dropped (e.g. Seedream 5.0's 1K) are never exposed.
> OpenAI Compatible (relay) pickers are driven by the `openaiCompatSizes` setting, shaped as ratio → tier → pixels, e.g. `{ "16:9": { "2K": "2048x1152" } }`; an empty table keeps the legacy 1:1 / 3:2 / 2:3 + standard behavior.

</details>

---

## Data and Privacy

- **BYOK:** API keys are stored through the DSH Credentials service and are never displayed in plaintext on the settings page.
- **Subscription sign-in:** Subscription tokens are saved in DSH Credentials after your authorized sign-in, fully isolated from API keys; the browser side never touches a token.
- **Cloud requests:** The prompt and reference images used for a request are sent to the selected Provider. Follow that Provider's terms of service.
- **Local ComfyUI:** Requests are sent to the configured ComfyUI address.
- **Workspace files:** When workspace saving is enabled, chat results are written to disk; Studio saves only the candidates you select.
- **Gallery and favorites:** Gallery metadata and favorite state are stored in the current browser's local storage.
- **Inspiration cache:** Example metadata ships with the plugin. Images load on demand and are cached locally, and the cache can be cleared at any time.

## FAQ

<details>
<summary><strong>What should I do if “Image Generation” is missing after installation?</strong></summary>

The settings entry depends on the DSH version: 0.1.6 and newer place it at **Settings → Plugins → Image Generation**, while 0.1.5 and earlier place it at **Settings → Plugins → Plugin Configuration → Image Generation**.

If it is missing in both places, fully restart the current DSH Profile, then inspect the plugin configuration:

```bash
dsh --profile web --dump-config
```

If `dsh-image-gen` is absent from the output, run the installation command again. When filing an issue, include the DSH version, plugin version, and relevant error logs, but never include your API key.

</details>

<details>
<summary><strong>Where are generated images saved?</strong></summary>

When “Save to workspace” is enabled, chat results are saved to the `dsh-image-gen/` subdirectory of the current workspace by default. You can change this directory in Settings. Studio candidates remain on the temporary canvas until you select which results should enter the gallery and be saved.

</details>

<details>
<summary><strong>Why is ComfyUI not available in Studio?</strong></summary>

Studio and multi-model comparison currently support cloud Providers only; ComfyUI is not yet integrated. ComfyUI supports text-to-image, single-image editing, and multiple named workflows through Agent chat.

</details>

<details>
<summary><strong>Does deleting an item from the gallery remove its chat message?</strong></summary>

No. Deleting a gallery record does not modify the original chat message. You may separately choose to remove the corresponding local image file from the workspace. File deletion is normally irreversible, so confirm carefully.

</details>

<details>
<summary><strong>How do I upgrade?</strong></summary>

```bash
pnpm dsh plugin --profile web add dsh-image-gen@latest
```

Restart the corresponding DSH Profile after upgrading.

</details>

---

## Local Development

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

Saving settings on modern DSH requires the actually loaded `@deepseek-ai/schemastery >=3.18.4 <4`. The card distinguishes loading, missing host forms, remote connections that cannot persist, and incompatible schemas. Legacy DSH settings interfaces are retained. Check the dependencies resolved in the plugin profile when updating, as well as those in the source checkout.

`test:package` requires network access. It installs the current build's tarball and pinned published DSH 0.2 settings services in a temporary directory, then uses real React rendering to verify card state, the bundled save handler, profile file persistence, a fresh form, host restart, and actionable refusal with old schemastery. Image APIs, browser DOM, and RPC transport are outside this test. CI runs it on Windows and Linux.

Feedback is welcome through [Issues](https://github.com/shanliuling/dsh-image-gen/issues). Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a Pull Request.

## License

This project is open source under the [Apache License 2.0](LICENSE).

<div align="center">

If `dsh-image-gen` improves your workflow, consider giving the project a ⭐ **Star** to support continued maintenance.

**[View Releases](https://github.com/shanliuling/dsh-image-gen/releases) · [Open an Issue](https://github.com/shanliuling/dsh-image-gen/issues) · [Contribute](CONTRIBUTING.md)**

</div>
