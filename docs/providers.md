# Provider 配置参考

<p><strong>简体中文</strong> · <a href="providers.en.md">English</a></p>

各 Provider 的默认模型、Endpoint、比例 / 清晰度，以及高级配置字段说明。功能支持概览见 [README](../README.md#provider-支持情况)。

## 当前默认模型与 Endpoint（均可修改）

| Provider           | 默认模型                     | 默认 Endpoint / Base URL                                        |
| :----------------- | :--------------------------- | :-------------------------------------------------------------- |
| Google Gemini      | `gemini-3.1-flash-image`     | `https://generativelanguage.googleapis.com/v1beta/interactions` |
| OpenAI Images      | `gpt-image-2.6-flare`        | `https://api.openai.com/v1`                                     |
| OpenAI Compatible  | 自定义                       | 自定义 Base URL                                                 |
| ByteDance Seedream | `doubao-seedream-5-0-pro-260628` | `https://ark.cn-beijing.volces.com/api/v3`                      |
| Aliyun DashScope   | `qwen-image-3.0`             | `https://dashscope.aliyuncs.com/api/v1`                         |
| xAI Grok Imagine   | `grok-imagine-image-2.0`     | `https://api.x.ai/v1`                                           |
| 智谱 GLM-Image     | `glm-image`                  | `https://open.bigmodel.cn/api/paas/v4`                         |
| Local ComfyUI      | 用户导入的 API Workflow      | `http://127.0.0.1:8188`                                         |
| ChatGPT 订阅       | `gpt-image-2.6-flare`（通道固定） | 账号登录，无需配置                                        |
| Grok 订阅         | `grok-imagine-image-2.0`（通道固定） | 账号登录，无需配置                                    |
| Google 订阅       | `gemini-3.1-flash-image`（通道固定） | 账号登录，无需配置                                        |

> 火山方舟于 2026-11-24 下线 `doubao-seedream-5-0-260128`（插件原默认）、`doubao-seedream-5-0-lite-260128` 与 `doubao-seedream-4-5-251128`；设置里保存的这些型号会自动改用 `doubao-seedream-5-0-pro-260628`，清晰度相应变为 1K / 1.5K / 2K。


## 各 Provider 可选比例与清晰度

| Provider           | 比例                                                              | 清晰度                                  |
| :----------------- | :---------------------------------------------------------------- | :-------------------------------------- |
| Google Gemini      | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 4:5 · 5:4 · 16:9 · 9:16 · 21:9      | 1K / 2K / 4K                            |
| OpenAI Images      | gpt-image-2 系列支持 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 | 分辨率 1K / 2K（宽屏、竖屏另有 4K）；生成质量独立选择 auto / low / medium / high |
| OpenAI Compatible  | 由 `openaiCompatSizes` 配置决定（默认 1:1 · 3:2 · 2:3）           | 分辨率由尺寸表决定；生成质量独立配置，默认不发送 |
| ByteDance Seedream | 自动 · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9           | 5.0 pro / flash：1K / 1.5K / 2K；更早的模型：2K / 3K / 4K |
| Aliyun DashScope   | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16                         | 标准                                    |
| xAI Grok Imagine   | 自动 · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9           | 1K / 2K                                 |
| 智谱 GLM-Image     | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16                         | 高清                                    |
| ChatGPT 订阅       | 自动 · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16                  | 自动 / low / medium / high / xhigh / max |
| Grok 订阅          | 自动 · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9           | 1K / 2K                                 |
| Google 订阅        | 自动 · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 4:5 · 5:4 · 16:9 · 9:16 · 21:9 | 标准 / 高清（4K）                     |

> 「自动」比例表示由模型按 Prompt 自行决定构图；上游已移除的档位（如 Seedream 5.0 的 1K）插件不会暴露。
> Google 订阅会使用有效的平台枚举发现账号项目，并提供普通 daily 入口作为兼容回退。项目发现未返回项目且提示 `UNSUPPORTED_CLIENT` 时，会再用 Antigravity 客户端身份重试；该过程不自动开户。仍未返回项目时保留旧兼容项目尝试，但不会把它缓存成账号真实项目；若生图仍失败，错误会保留项目发现、账号资格及各生图入口的脱敏响应，避免只显示最后一个 429。设置中的订阅「测试连接」只检查登录记录，实际生图成功才验证该账号的生图链路；`UNSUPPORTED_CLIENT` 的 Code Assist 提示也不单独判定生图不可用。
> OpenAI 与兼容渠道的 Studio 控件分别显示「比例 / 分辨率 / 生成质量」，分辨率选项会显示实际像素。多模型对比及再次生成也保留这两类参数。
> OpenAI 官方可通过设置中的 `openaiSizes` 自定义尺寸表，格式为「比例 → 档位 → 像素」，例如 `{ "16:9": { "2K": "2048x1152", "4K": "3840x2160" } }`。gpt-image-2 系列按官方限制校验：边长为 16 的倍数、最大 3840、比例在 1:3 到 3:1、总像素 655360–8294400；超过 3686400 像素的输出属于上游实验支持。[官方说明](https://developers.openai.com/api/reference/resources/images/methods/generate)。旧版 GPT Image 模型仍只使用三种标准尺寸。
> 对话生图与图生图（`generate_image`、`generate_images`、`edit_image`）可请求 GIF：`output_format: gif`，可选 `frame_count`（2–16）与 `frame_duration_ms`（20–2000 ms，服务端按 10 ms 取整），仅 OpenAI 与兼容渠道接受，需模型与中转支持（ChatGPT 订阅使用的 Codex 图片接口实测拒绝 `output_format: gif`）；图生图只按单次调用的参数出 GIF，不读取下面的文生图额外字段。GIF 的 `size` 是单帧尺寸，不指定时由服务端决定；插件只校验边长为 16 的倍数且不超过 3840——所有帧会拼成一张 sheet，其最长边也不得超过 3840，帧越多单帧应越小；上游仍可能套用静态图的像素下限（实测有中转要求单帧总像素不低于 655360，约 816×816），也可能忽略帧数、帧时长与尺寸参数而按默认值出图。
> OpenAI Compatible 的尺寸表为 `openaiCompatSizes`，格式相同；留空时保持原来的标准尺寸。`openaiCompatQuality` 设置默认生成质量（留空不发送），`openaiCompatQualityOptions` 设置 Studio 可选值。选择「渠道默认（不发送）」可在单次请求中省略 quality；对话工具也支持独立的 `size` 和 `quality` 参数。
> 对话**文生图**还可用 `output_format: "svg"` 请求矢量结果（仅 OpenAI 与兼容渠道；图生图接口不支持 SVG）。DSH 附件层只接受 png/jpeg/webp/gif，SVG 因此写入工作区的 `.svg` 文件、把源码放进工具结果，并由对话卡片直接按源码渲染（图库与版本历史仍只收录位图）；矢量图没有像素尺寸，`size` / `aspect_ratio` / `image_size` 不会发送，`frame_count` / `frame_duration_ms` 与 SVG 同时出现会报错。
>
> 兼容渠道的「文生图额外字段」对应 `openaiCompatExtraBody`，例如 `{ "watermark": false }`。它仅用于文生图，在常规字段之后合并，可覆盖同名参数；`false` 和嵌套对象都会保留。单次对话调用也可用 `output_format` / `frame_count` / `frame_duration_ms` 参数覆盖这里的同名字段。GIF 结果在卡片或图库里「重新生成」时仍请求 GIF，并沿用原来的帧数、帧时长与单帧尺寸；工作台里由这里的 `output_format: gif` 出图时，只有配置了 `openaiCompatSizes` 尺寸表才发送所选 `size`，否则不发送尺寸、由服务端决定。图生图继续使用 `openaiCompatEditExtra`；JSON 图片 URL 数组格式的 `openaiCompatEditSizeMode` 默认 `auto`，改为 `selected` 才发送所选尺寸，EditExtra 仍可覆盖该尺寸。按帧编辑发出的图生图请求把所有帧拼成一张参考拼图作唯一参考图：单帧尺寸作为 `size` 发送，`output_format: gif`、帧数与帧时长在常规字段之后合并；渠道的图生图接口需接受这些 GIF 输出参数（默认的多部分表单即 `images/edits`）。
> 兼容渠道可设置独立的「图生图模型」`openaiCompatEditModel`，留空沿用文生图模型；对话中的显式 `model` 仍可覆盖单次编辑。硅基流动官方 `/v1` 地址自动使用 `siliconflowJson` 编辑格式，其他采用同一协议的中转可手动选择：通过 `/images/generations` 发送 `image` 字符串。`Qwen/Qwen-Image-Edit` 支持一张参考图，`Qwen/Qwen-Image-Edit-2509` 最多三张，依次使用 `image`、`image2`、`image3`。编辑不发送通用尺寸和质量字段；图生图额外字段中的 `size`、`image_size`、`quality` 会给出明确错误，图片字段由插件填入。协议以[硅基流动官方文档](https://docs.siliconflow.cn/docs/api/images-generations-post)为准。
> 普通对话生图无需指定 provider 或 model，会使用已保存的默认渠道；模型可读取随配置更新的默认渠道及参数提示。无关可选字段应省略，空白尺寸会按未提供处理；两个有效的 `size` / `aspect_ratio` 仍互斥。ChatGPT 订阅不支持 `image_size`，请使用 `size` 或 `aspect_ratio`，不要填入 `1K` 等档位。
> 工作台在比例、分辨率旁提供「可见水印：渠道默认 / 关闭 / 开启」，分别判断文生图和图生图支持情况。Seedream、通义原生 Qwen Image，以及已确认的商汤和通义官方兼容接口自动启用；官方兼容接口同时自动使用对应的 JSON 编辑格式。商汤匹配 `https://token.sensenova.cn/v1` 与 `sensenova-u1.5-lite`；通义匹配官方工作空间域名的 `/compatible-mode/v1` 与 Qwen Image 3.0/3.0 Pro、2.1 Pro/Turbo。其他兼容渠道可通过对应操作的额外字段绑定布尔值 `watermark`、`watermark_enabled` 或 `parameters.watermark`；图生图绑定仅用于 JSON 编辑格式。未知渠道和智谱显示禁用的「支持未确认」，无已确认开关的接口也显示说明。不会仅凭模型名识别未知中转。渠道默认保留原配置或省略参数，单次选择只覆盖水印字段；批量生成、支持该操作的对比模型及再次生成会保留选择。
