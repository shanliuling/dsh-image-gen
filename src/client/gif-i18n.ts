/**
 * Copy for the GIF player and the card's saved-file opener, kept apart from
 * the plugin dictionary so this UI ships as its own files.
 */
export const GIF_TEXT = {
  zh: {
    gifBadge: 'GIF 动图',
    openInSidebar: '在右侧栏打开',
    notSavedVersion: '这个版本没有保存到工作区',
    gifControls: 'GIF 播放控制',
    gifPlay: '播放 GIF',
    gifPause: '暂停 GIF',
    gifPlayTitle: '播放 GIF（空格）',
    gifPauseTitle: '暂停 GIF（空格）',
    gifFrames: 'GIF 帧',
    gifFrameOf: '第 {current} 帧，共 {total} 帧',
    gifStripHint: '悬停预览，点击停在这一帧，← → 逐帧',
    gifStripHintGallery: '悬停预览，点击停在这一帧；焦点在这里时 ← → 逐帧，其它时候 ← → 翻页',
    gifSpeed: '播放速度',
    gifSpeedHint: '拖动调整播放速度（0.2×–2×），双击恢复 1×',
    gifFaster: '更快',
    gifSlower: '更慢',
    gifDownloadMenu: '下载',
    gifDownload: '下载 GIF',
    gifDownloadSpeed: '下载 GIF（{speed}×）',
    gifDownloadHintOriginal: '原速动图',
    gifDownloadHintSpeed: '按当前播放速度',
    gifDownloadOriginal: '下载原速 GIF',
    gifDownloadOriginalHint: '不改变帧时长',
    gifDownloadFrame: '下载当前帧（PNG）',
    gifDownloadFrameHint: '第 {frame} 帧，静态图',
    gifCopyFrame: '复制当前帧（静态图）',
    gifCopyFirstFrame: '复制首帧（静态图）',
    gifCopiedFrame: '已复制第 {current}/{total} 帧（静态图）；要动图请下载或拖出',
    gifCopiedFirstFrame: '已复制首帧（静态图）；要动图请下载或拖出',
    gifCopyFailed: '复制失败',
    gifClose: '关闭（Esc）',
    gifControlsUnavailable: '此环境不支持逐帧控制，动图仍可下载',
  },
  en: {
    gifBadge: 'Animated GIF',
    openInSidebar: 'Open in the sidebar',
    notSavedVersion: 'This version was not saved to the workspace',
    gifControls: 'GIF playback controls',
    gifPlay: 'Play GIF',
    gifPause: 'Pause GIF',
    gifPlayTitle: 'Play GIF (Space)',
    gifPauseTitle: 'Pause GIF (Space)',
    gifFrames: 'GIF frames',
    gifFrameOf: 'Frame {current} of {total}',
    gifStripHint: 'Hover to preview, click to stop on this frame, ← → to step',
    gifStripHintGallery: 'Hover to preview, click to stop on this frame; ← → step frames while this has focus and turn pages otherwise',
    gifSpeed: 'Playback speed',
    gifSpeedHint: 'Drag to change the playback speed (0.2×–2×); double-click for 1×',
    gifFaster: 'Faster',
    gifSlower: 'Slower',
    gifDownloadMenu: 'Download',
    gifDownload: 'Download GIF',
    gifDownloadSpeed: 'Download GIF ({speed}×)',
    gifDownloadHintOriginal: 'Animation at its own speed',
    gifDownloadHintSpeed: 'At the current playback speed',
    gifDownloadOriginal: 'Download original-speed GIF',
    gifDownloadOriginalHint: 'Frame timing unchanged',
    gifDownloadFrame: 'Download frame (PNG)',
    gifDownloadFrameHint: 'Frame {frame}, still image',
    gifCopyFrame: 'Copy frame (still)',
    gifCopyFirstFrame: 'Copy first frame (still)',
    gifCopiedFrame: 'Frame {current} of {total} copied as a still; download or drag out for the GIF',
    gifCopiedFirstFrame: 'First frame copied as a still; download or drag out for the GIF',
    gifCopyFailed: 'Copy failed',
    gifClose: 'Close (Esc)',
    gifControlsUnavailable: 'Frame-by-frame controls are not available here; the GIF can still be downloaded',
  },
} as const

export type GifTextKey = keyof typeof GIF_TEXT.zh
export type GifT = (key: GifTextKey, params?: Record<string, string>) => string

export function gifT(lang: 'zh' | 'en'): GifT {
  return (key, params) => {
    let text: string = GIF_TEXT[lang][key]
    for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, value)
    return text
  }
}
