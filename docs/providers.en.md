# Provider Configuration Reference

<p><a href="providers.md">简体中文</a> · <strong>English</strong></p>

Default models, endpoints, aspect ratios / quality tiers, and advanced configuration fields for each Provider. For the capability overview, see the [README](../README.en.md#provider-support).

## Current default models and endpoints (all configurable)

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


## Aspect ratios and quality tiers per Provider

| Provider | Aspect ratios | Quality tiers |
| :--- | :--- | :--- |
| Google Gemini | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 4:5 · 5:4 · 16:9 · 9:16 · 21:9 | 1K / 2K / 4K |
| OpenAI Images | gpt-image-2 family: 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 | Resolution: 1K / 2K (also 4K for landscape/portrait widescreen); separate quality: auto / low / medium / high |
| OpenAI Compatible | Driven by `openaiCompatSizes` (default 1:1 · 3:2 · 2:3) | Resolution from the size table; separate configurable quality, omitted by default |
| ByteDance Seedream | auto · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9 | 2K / 3K / 4K |
| Aliyun DashScope | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 | standard |
| xAI Grok Imagine | auto · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9 | 1K / 2K |
| Zhipu GLM-Image | 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 | hd |
| ChatGPT subscription | auto · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 | auto / low / medium / high / xhigh / max |
| Grok subscription | auto · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9 | 1K / 2K |
| Google subscription | auto · 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 4:5 · 5:4 · 16:9 · 9:16 · 21:9 | standard / HD (4K) |

> An `auto` ratio lets the model pick the framing from the prompt; tiers the upstream dropped (e.g. Seedream 5.0's 1K) are never exposed.
> Google subscription discovers account projects with valid platform enums and includes the ordinary daily endpoint as a compatibility fallback. When discovery returns no project with `UNSUPPORTED_CLIENT`, it retries using the Antigravity client identity without automatically onboarding the account. If discovery still returns no project, the legacy compatibility project is still tried but is not cached as an actual account project. Generation failures retain redacted discovery, eligibility, and per-endpoint diagnostics instead of only the last 429. The subscription “Test connection” checks stored sign-in status; successful generation verifies image access for that account. A Code Assist `UNSUPPORTED_CLIENT` response alone does not establish that image generation is unavailable.
> Studio exposes separate aspect ratio, resolution, and generation quality controls for OpenAI and compatible providers. Resolution labels show pixel dimensions. Comparison and regeneration preserve these separate parameters.
> Official OpenAI size presets can be customized with `openaiSizes`, shaped as ratio → tier → pixels, e.g. `{ "16:9": { "2K": "2048x1152", "4K": "3840x2160" } }`. For the gpt-image-2 family, dimensions must be multiples of 16, the longest edge at most 3840, aspect ratio within 1:3–3:1, and total pixels within 655360–8294400. Outputs above 3686400 pixels have experimental upstream support. See the [official API reference](https://developers.openai.com/api/reference/resources/images/methods/generate). Older GPT Image models retain their three standard sizes.
> Compatible providers use `openaiCompatSizes` in the same format; an empty table retains the legacy sizes. `openaiCompatQuality` sets the default generation quality (empty means omitted), and `openaiCompatQualityOptions` sets Studio choices. Choosing “Provider default (omit)” omits quality for that request. Conversation tools also accept independent `size` and `quality` parameters.
> “Generation extra fields” maps to `openaiCompatExtraBody`, e.g. `{ "watermark": false }`. These fields apply only to generation, merge after standard fields, and can override matching keys; `false` and nested objects are preserved. Editing continues to use `openaiCompatEditExtra`. For JSON image URL array edits, `openaiCompatEditSizeMode` defaults to `auto`; set it to `selected` to send the selected dimensions. EditExtra can still override size.
> Compatible channels can set a separate editing model with `openaiCompatEditModel`; empty reuses the generation model, and an explicit conversation-tool `model` still overrides one edit. Official SiliconFlow `/v1` endpoints automatically use `siliconflowJson`; relays implementing the same contract can select it manually. Edits post an `image` string to `/images/generations`. `Qwen/Qwen-Image-Edit` supports one reference; `Qwen/Qwen-Image-Edit-2509` supports up to three using `image`, `image2`, and `image3` in order. Generic size and quality fields are omitted; `size`, `image_size`, or `quality` in editing extras produce an actionable error, and the plugin fills reference fields. See the [SiliconFlow API reference](https://docs.siliconflow.cn/docs/api/images-generations-post).
> Ordinary conversation requests should omit provider and model to use the saved default. The model receives live default-provider and parameter instructions. Omit unused optional fields; blank dimensions are treated as absent, while two nonempty `size` / `aspect_ratio` values still conflict. ChatGPT subscription does not accept `image_size`; use `size` or `aspect_ratio` rather than a tier such as `1K`.
> The workbench shows “Visible watermark: Channel default / Off / On” beside ratio and resolution, checking generation and editing separately. Seedream, native DashScope Qwen Image, and recognized official SenseNova and Qwen compatible endpoints enable it automatically; recognized compatible endpoints also select their JSON edit contracts automatically. SenseNova matches `https://token.sensenova.cn/v1` and `sensenova-u1.5-lite`; Qwen matches official workspace hosts under `/compatible-mode/v1` with Qwen Image 3.0/3.0 Pro or 2.1 Pro/Turbo. Other compatible channels can bind a boolean `watermark`, `watermark_enabled`, or `parameters.watermark` through the matching operation's extra fields; editing requires a JSON format. Unknown channels and Zhipu display a disabled “Support unconfirmed” control; interfaces without a confirmed switch also show an explanation. A model name alone does not identify an unknown relay. Channel default preserves configured fields or omits the parameter; an explicit choice overrides only the watermark field and is retained for batches, comparison models supporting the operation, and regeneration.
