const RATIO_LABELS: Record<string, { zh: string; en: string }> = {
  auto: { zh: '自动', en: 'Auto' },
  '1:1': { zh: '1:1 方形', en: '1:1 Square' },
  '3:2': { zh: '3:2 横向', en: '3:2 Landscape' },
  '2:3': { zh: '2:3 肖像', en: '2:3 Portrait' },
  '4:3': { zh: '4:3 横向', en: '4:3 Landscape' },
  '3:4': { zh: '3:4 竖向', en: '3:4 Portrait' },
  '4:5': { zh: '4:5 肖像', en: '4:5 Portrait' },
  '5:4': { zh: '5:4 横向', en: '5:4 Landscape' },
  '16:9': { zh: '16:9 宽屏', en: '16:9 Widescreen' },
  '9:16': { zh: '9:16 竖屏', en: '9:16 Portrait' },
  '21:9': { zh: '21:9 超宽', en: '21:9 Ultrawide' },
  '2:1': { zh: '2:1 全景', en: '2:1 Panorama' },
  '1:2': { zh: '1:2 竖向', en: '1:2 Portrait' },
  '3:1': { zh: '3:1 全景', en: '3:1 Panorama' },
  '1:3': { zh: '1:3 长条', en: '1:3 Tall' },
  '9:21': { zh: '9:21 超高', en: '9:21 Tall' },
  '7:5': { zh: '7:5 横向', en: '7:5 Landscape' },
  '5:7': { zh: '5:7 肖像', en: '5:7 Portrait' },
  '5:2': { zh: '5:2 超宽', en: '5:2 Ultrawide' },
  '9:19.5': { zh: '9:19.5 竖屏', en: '9:19.5 Portrait' },
  '19.5:9': { zh: '19.5:9 宽屏', en: '19.5:9 Widescreen' },
  '9:20': { zh: '9:20 竖屏', en: '9:20 Portrait' },
  '20:9': { zh: '20:9 宽屏', en: '20:9 Widescreen' },
  '4:1': { zh: '4:1 全景', en: '4:1 Panorama' },
  '1:4': { zh: '1:4 长条', en: '1:4 Tall' },
  '8:1': { zh: '8:1 全景', en: '8:1 Panorama' },
  '1:8': { zh: '1:8 长条', en: '1:8 Tall' },
  '2.35:1': { zh: '2.35:1 超宽', en: '2.35:1 Ultrawide' },
}

export function ratioLabel(value: string, lang: 'zh' | 'en'): string {
  return Object.hasOwn(RATIO_LABELS, value) ? RATIO_LABELS[value]![lang] : value
}
