# dsh-image-gen · NVIDIA NIM（FLUX.3 Klein）接入改动清单

> **分支** `feat/nvidia-nim-provider` · **基线** v0.11.4（main @ 11891ab） · **实现提交** `8b658c1`（15 个文件，+355/−12）
> **验证状态** `pnpm typecheck` 0 错误 · vitest 全套 85 文件 / 1225 测试通过（含新增 6 例）
> 本 README 仅收录本次接入的改动说明，供上游作者逐条核实；原项目介绍见上游 main 分支。

## 目录

1. [为什么要新增 provider（接口契约）](#1-为什么要新增-provider接口契约)
2. [新增文件逐项说明](#2-新增文件)
3. [修改文件逐项说明（13 个）](#3-修改文件13-个)
4. [明确不做 / 已知限制](#4-明确不做--已知限制)
5. [配置与使用方式](#5-配置与使用方式)
6. [核实命令与预期结果](#6-核实命令与预期结果)

## 1. 为什么要新增 provider（接口契约）

NVIDIA NIM 对该模型暴露的是**自定义 genai 契约，不是 OpenAI Images 协议**，无法复用 `openai-compatible.ts` 共用适配器（它面向 `/images/generations` + `b64_json`/URL 形态），因此仿照 `dashscope.ts` 的原生 provider 模式新增 `src/nvidia.ts`。关键差异：

- 端点 `POST https://ai.api.nvidia.com/v1/genai/{model}`，**模型 id 在 URL 路径里，不在 body**
- 请求体 `ImageRequest` 且 `additionalProperties: false` —— 只允许 7 个字段，多发任何字段直接 422
- 响应是 `{ artifacts: [{ base64 (JPEG), finishReason }] }`，没有 OpenAI 的 `data[0].b64_json` / URL 形态

### 1.1 请求契约（ImageRequest）

| 字段 | 类型 | 范围 | 默认 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `prompt` | string | 必填，≤2000 字符 | — | 生成/编辑共用的文本提示 |
| `width` | integer | 512–1568，16 的倍数 | 1024 | 与 height 乘积 ≤ 1,062,400 像素 |
| `height` | integer | 512–1568，16 的倍数 | 1024 | 同上 |
| `cfg_scale` | number | >1，≤20 | 3.5 | prompt 遵从度 |
| `steps` | integer | 1–50 | 50 | 扩散步数 |
| `image` | string[] | data-URL，≤10 张 | — | 编辑参考图；Preview 环境仅接受 example_id 0–3 |
| `samples` | integer | 仅 1 | 1 | 上游限制 |

### 1.2 响应契约（ImageResponse）

- `artifacts[0].base64`：JPEG 字节流的 base64 字符串（魔数 `/9j/` 开头）
- `artifacts[0].finishReason`：`SUCCESS`（成功）/ `ERROR`（失败）/ `CONTENT_FILTERED`（命中内容过滤）
- 422：`HTTPValidationError { detail: [{ loc, msg, type }] }`

## 2. 新增文件

### 2.1 `src/nvidia.ts`（143 行）

**导出接口与函数**

- `NvidiaImageOptions`：`apiKey` / `endpoint` / `model` / `prompt` / `size?`（WIDTHxHEIGHT）/ `cfgScale?` / `steps?` / `maxBytes` / `strictImageDownloads?` / `signal?`
- `NvidiaEditOptions extends NvidiaImageOptions`：`sourceImages: Array<{ data: Uint8Array; mediaType }>`
- `generateNvidiaImage(options)` / `editNvidiaImage(options)` → `Promise<{ data: Uint8Array; mediaType }>`

**内部实现与校验顺序**（校验全部在发请求之前完成）

1. `prompt` 长度 > 2000 → 抛错（含实际长度）
2. `parseNvidiaSize()`：解析 `WIDTHxHEIGHT`，三重校验——每边 512–1568、16 的倍数、面积 ≤ 1,062,400；非法直接抛错，不发请求
3. URL 拼接：`endpoint` 去尾斜杠 + `/genai/` + `model`（模型 id 含 `/`，如 `black-forest-labs/flux-3-image-klein`）
4. 请求头：`content-type: application/json` + `accept: application/json` + `authorization: Bearer {key}`
5. 请求体只组 schema 字段：`prompt` / `width` / `height`，可选 `cfg_scale` / `steps`，编辑时追加 `image`（参考图转 data-URL 数组）
6. 非 2xx：读响应体经 `redactSecrets` 脱敏后抛错（含 HTTP 状态码）
7. `artifacts[0]` 缺失或 `base64` 为空 → 报错（含脱敏后的 `message`/`title`）
8. `finishReason !== 'SUCCESS'`：`CONTENT_FILTERED` 转成用户可读的中文提示，其余 reason 原样抛出
9. `maxBytes` 上限检查；`detectImageMediaType` 按魔数嗅探媒体类型（不信任声明，杜绝 `IMAGE_TYPE_MISMATCH`）
10. 编辑入口：0 张参考图拒绝；超过 10 张拒绝（报错带实际数量）

**复用的既有基础设施**（与 `dashscope.ts` 同一套）：`guardedFetch` / `readResponseBody`（fetch-diagnostics）、`redactSecrets`（redact）、`detectImageMediaType`（reference-image）

### 2.2 `tests/nvidia.spec.ts`（96 行，6 用例）

| 用例 | 断言 |
| :--- | :--- |
| 正常生成 | URL 精确等于 `https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux-3-image-klein`；三个请求头；body 恰为 `{ prompt, width: 1024, height: 1024 }` 无多余字段；JPEG 字节还原、`mediaType` 为 `image/jpeg` |
| 尺寸越界（1600x1600） | 报错含 `outside 512-1568 or not a multiple of 16`，且 **fetch 未被调用**（请求前拦截） |
| CONTENT_FILTERED | 转成含 `CONTENT_FILTERED` 的用户可读报错 |
| HTTP 401 | 报错含 `(401)` 与脱敏后的响应体 |
| 编辑请求体 | `image` 为 `data:image/jpeg;base64,...` 数组且字节与参考图一致 |
| 11 张参考图 | 报错含 `at most 10 reference images` |

mock 方式与 `dashscope.spec.ts` 相同：`vi.stubGlobal('fetch', ...)` + `Response` 构造。

## 3. 修改文件（13 个，除特别说明外均为追加行）

> TS 的穷举约束（`Record<ImageProvider, ...>`、`satisfies` 等）使每个映射漏加 `nvidia` 都会编译失败，实现以 `pnpm typecheck` 0 错误兜底。

### 3.1 `src/shared.ts`

| 位置 | 改动 |
| :--- | :--- |
| `IMAGE_PROVIDERS` | 追加 `'nvidia'`（zhipu 之后、comfyui 之前） |
| `CLOUD_IMAGE_PROVIDERS` | 追加 `'nvidia'` |
| 凭据常量区 | 新增 `NVIDIA_API_KEY_ENV = 'NVIDIA_API_KEY'` |
| `CLOUD_CREDENTIAL_REFS` | `nvidia: NVIDIA_API_KEY_ENV` |
| `PROVIDER_DISPLAY_NAMES` | `nvidia: 'NVIDIA NIM'` |
| `DEFAULT_MODELS` | `nvidia: DEFAULT_NVIDIA_MODEL` |
| `DEFAULT_BASE_URLS` | `nvidia: DEFAULT_NVIDIA_ENDPOINT` |
| `API_KEY_CONSOLE_URLS` | `nvidia: 'https://build.nvidia.com'`（key 获取入口） |
| 默认值常量 | `DEFAULT_NVIDIA_ENDPOINT = 'https://ai.api.nvidia.com/v1'`、`DEFAULT_NVIDIA_MODEL = 'black-forest-labs/flux-3-image-klein'` |

### 3.2 `src/capabilities.ts`

- 顶部 vendor 说明注释补 nvidia 一行
- 新增 `NVIDIA_SIZE_TABLE` 9 档（每档均满足 schema 三重限制）：`1:1→1024x1024`、`3:2→1248x832`、`2:3→832x1248`、`4:3→1152x864`、`3:4→864x1152`、`16:9→1168x656`、`9:16→656x1168`、`21:9→1232x528`、`9:21→528x1232`
- `CLOUD_CAPABILITIES.nvidia`：ratioOptions 取自表；quality 仅「标准」（端点无 quality 字段）；`sizeFor` 直查表，兜底 `1024x1024`

### 3.3 `src/config.ts`

- `Config` 接口追加 `nvidiaEndpoint?` / `nvidiaModel?`
- import 与 re-export 块追加 `DEFAULT_NVIDIA_ENDPOINT` / `DEFAULT_NVIDIA_MODEL` / `NVIDIA_API_KEY_ENV`
- schemastery schema：`nvidiaEndpoint` / `nvidiaModel` 两项 `volatile` 默认值（设置页表单由此生成）
- `resolveProvider` 联合类型加 nvidia 变体；`case 'nvidia'` 返回 `{ provider, apiKeyEnv, model, endpoint, imageSize: '1024x1024' }`
- `withProviderOverrides` 加 `case 'nvidia'`（支持 Agent 单次调用的 `model` 覆盖）

### 3.4 `src/index.ts`（Agent 工具路径）

- import `{ editNvidiaImage, generateNvidiaImage }`
- `generateSingle`：dashscope 分支后新增 `provider === 'nvidia'` 分支——`size = args.size ?? active.imageSize`，经 `runCloud` 包裹（受 `cloudTimeoutMs` 约束），`saveGenerated` 记录尺寸
- `edit_image`：seedream 分支后、**dashscope fallback 之前**插入显式分支（关键：不加会误走 `editDashScopeImage`，因为 dashscope 是该函数的最终兜底）
- `generate_image` / `generate_images` / `edit_image` 三个工具 schema 的 `provider` 枚举追加 `'nvidia'`；三处 `size` 参数描述补充 NVIDIA NIM

### 3.5 `src/studio.ts`（工作台路径）

- import；分发链新增 `else if (wired.provider === 'nvidia')`：尺寸来自 `CLOUD_CAPABILITIES.nvidia.sizeFor?.(ratio, quality)`；图生图传 `sourceImages`、文生图不传
- `CLOUD_DISPLAY_LABELS` 追加 `nvidia: 'NVIDIA NIM'`

### 3.6 `src/test-route.ts`（连接测试与拉取模型）

- `probeTarget` 加 `case 'nvidia'`：探测 `https://integrate.api.nvidia.com/v1/models` —— 生成主机 `ai.api.nvidia.com` 没有 `/models`；目录在共享同一把 nvapi key 的 integrate 主机上
- 新增 `fetchNvidiaImageModels(apiKey, signal)`：GET 上述目录 → `parseOpenAIModelIds` → `filterRelayImageModelIds`（flux / sd / image 等片段过滤）
- `serveTestConnection` 的 `action === 'models'` 分发链加 nvidia 分支（设置页「拉取模型」按钮由此生效）

### 3.7 `src/channel-model-discovery.ts`（工作台模型发现）

- `DISCOVERABLE_OFFICIAL` 追加 `'nvidia'`；import `fetchNvidiaImageModels`；`discoverOfficialModels` 分发链加分支（5 分钟 TTL 缓存逻辑对 nvidia 同样生效）

### 3.8 `src/client/index.tsx`（设置卡）

- `ImageSettings` 镜像接口追加 `nvidiaEndpoint?` / `nvidiaModel?`
- `CLOUD_MODEL_FIELDS`：`nvidia: 'nvidiaModel'`；`CLOUD_URL_FIELDS`：`nvidia: 'nvidiaEndpoint'`；`CLOUD_HINT_KEYS`：`nvidia: 'endpointHintNvidia'`（三者带 `satisfies Record<CloudImageProvider, ...>` 穷举约束）
- `providerLabels` 追加 `nvidia: t('providerNvidia')`

### 3.9 `src/client/provider-pill.tsx`（悬浮球）

- `PILL_PROVIDER_LABELS` zh / en 各追加 `nvidia: 'NVIDIA NIM'`

### 3.10 `src/client/plugin-i18n.ts`（中英文案）

- zh：`providerNvidia: 'NVIDIA NIM'`；`endpointHintNvidia: 'NVIDIA NIM 原生地址，默认 https://ai.api.nvidia.com/v1；模型 id 会拼进 URL 路径。'`
- en：同名 key 的英文文案（Native NVIDIA NIM endpoint…）

### 3.11 文档

- 本 README（分支专用 review 文档；合并前由维护者决定去留）
- `docs/providers.md` / `docs/providers.en.md`：「默认模型与 Endpoint」「比例与清晰度」两张表各加一行 NVIDIA NIM / FLUX

## 4. 明确不做 / 已知限制

- **GIF / SVG**：端点不支持，现有 `assertGifProvider` 逻辑对 nvidia 自动拒绝 `output_format`，未做特殊适配
- **`quality` 工具参数**：对 nvidia 无效（端点无该字段）；工作台 quality 固定「标准」
- **不发送** `seed` / `negative_prompt` / `n`：`ImageRequest` 无这些字段且 `additionalProperties: false`，发送即 422
- **`samples` 固定 1**：上游限制
- **Preview 环境**：`image` 仅接受 example_id 0–3；插件按正式端点契约实现（真实 data-URL，≤10 张）
- **水印控件**：对 nvidia 显示「支持未确认」（复用通用逻辑）

## 5. 配置与使用方式

1. **设置** > 插件 > 图像生成 → NVIDIA NIM 行：粘贴 build.nvidia.com 领取的 nvapi key；endpoint 默认 `https://ai.api.nvidia.com/v1`（自建网关可改，模型 id 拼在 `/genai/` 后）；「测试连接」探测 integrate 目录；「拉取模型」列出图像模型 id
2. **对话**：`generate_image({ provider: "nvidia", prompt, size?, aspect_ratio? })`；编辑用 `edit_image({ provider: "nvidia", prompt, source_attachment_id? })`
3. **Studio 工作台**：provider 选 NVIDIA NIM，比例 9 档，图生图最多 10 张参考图

## 6. 核实命令与预期结果

```bash
pnpm install
pnpm typecheck                              # 0 错误
pnpm exec vitest run tests/nvidia.spec.ts   # 6 个测试通过
pnpm exec vitest run                        # 全套 85 文件 / 1225 测试通过
```

**提交记录**：`8b658c1`（实现，15 文件 +355/−12）→ `d319ea9` / `2ae9cf3` / `105b262`（本文档迭代）