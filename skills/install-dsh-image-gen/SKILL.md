---
name: install-dsh-image-gen
description: Install, configure, verify, or remove the dsh-image-gen Bundle in a DeepSeek Harness Web profile. Use when a user wants Google, OpenAI-compatible relay, Seedream, DashScope, or local ComfyUI image generation in DSH, cannot find the Image generation settings card, or needs help testing generate_image.
---

# Install DSH Image Gen

1. Confirm `dsh` runs and record `dsh --version`.
2. Ask which Web profile to change if the user did not name one. Default to `web` only when that profile already exists.
3. Install the pinned package or repository spec the user provides:

   ```sh
   dsh plugin --profile <profile> add <package-or-git-spec>
   ```

4. If pnpm blocks the Git dependency's `prepare` script, explain that the allowance executes repository code during installation. Add only the exact package key pnpm reports to the profile's `pnpm-workspace.yaml`, then retry after the user approves.
5. Verify `dsh --profile <profile> --dump-config` contains the `dsh-image-gen` layer and `image-gen` row.
6. Start the profile. If port 3080 is already in use, identify the existing DSH process before stopping anything.
7. In Settings > Plugins > Plugin configuration > Image generation, select a cloud Provider and save its API key, or select Local ComfyUI, enter its URL, and import a ComfyUI API Format workflow JSON containing `{{prompt}}`. Never print, read back, or commit a key.
8. Test with “生成一张戴墨镜的赛博朋克猫图片”. Confirm one `generate_image` call succeeds and its image renders in the conversation.

For removal, run `dsh plugin --profile <profile> remove dsh-image-gen`. Do not delete the user's credentials unless they explicitly request it.
