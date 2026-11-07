/** Styles of the GIF player (card overlays, the lightbox player, its menus, the gallery hover) and of the card's saved-file link. */
export const GIF_STYLE = `
/* The host draws corners as superellipses; circles and pills here say corner-shape:round, as the host's own do. */
.dsh-ig-savedto-open{appearance:none;display:inline-block;max-width:calc(100% - 5em);margin:0;padding:0;border:0;background:none;font:inherit;color:var(--dsw-alias-link,#3b6cf0);text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;cursor:pointer}
.dsh-ig-savedto-open:hover{text-decoration:underline}
.dsh-ig-container.is-gif-open{overflow:visible}
.dsh-ig-toolbar.is-pinned{opacity:1;pointer-events:auto}
/* Above the chips only while its own menu is open, so it never covers the speed panel. */
.dsh-ig-toolbar:has(.dsh-ig-dl-menu){z-index:4}
.dsh-ig-toolbar .dsh-ig-tool-btn:disabled{opacity:.4;cursor:default;background:transparent}
.dsh-ig-gif-badge{margin-left:8px;vertical-align:middle;font-size:11px;font-weight:600}
.dsh-ig-gif-chip-slot{position:absolute;left:12px;bottom:12px;z-index:3;line-height:normal}
.dsh-ig-gif-chip{corner-shape:round;appearance:none;border:0;min-width:44px;height:36px;padding:0 10px;border-radius:999px;background:rgba(17,20,26,0.6);color:#fff;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.dsh-ig-gif-chip:hover:not(:disabled){background:rgba(17,20,26,0.8)}
.dsh-ig-gif-chip:disabled{opacity:.55;cursor:default}
.dsh-ig-speed{position:relative;display:inline-flex}
.dsh-ig-speed-panel{corner-shape:round;position:absolute;bottom:calc(100% + 10px);left:50%;transform:translateX(-50%);width:52px;height:212px;box-sizing:border-box;padding:10px 0;border-radius:26px;background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-tertiary,#8a8f99);box-shadow:0 10px 30px rgba(15,23,42,0.18),0 0 0 1px rgba(15,23,42,0.06);display:flex;flex-direction:column;align-items:center;gap:8px;z-index:20;line-height:normal}
.dsh-ig-speed-bar .dsh-ig-speed-panel{bottom:calc(100% + 12px);background:rgba(32,35,42,0.96);color:rgba(255,255,255,0.6);box-shadow:0 10px 30px rgba(0,0,0,0.45)}
.dsh-ig-speed-bar .dsh-ig-speed-rail{background:rgba(255,255,255,0.18)}
.dsh-ig-speed-bar .dsh-ig-speed-fill{background:#5b8cff}
.dsh-ig-speed-bar .dsh-ig-speed-one{background:rgba(255,255,255,0.45)}
.dsh-ig-speed-chip .dsh-ig-speed-panel{left:0;transform:none}
.dsh-ig-speed-icon{display:flex}
.dsh-ig-speed-track{position:relative;width:28px;height:150px}
.dsh-ig-speed-rail,.dsh-ig-speed-fill{corner-shape:round;position:absolute;left:11px;width:6px;border-radius:3px}
.dsh-ig-speed-rail{top:0;bottom:0;background:rgba(127,127,127,0.25)}
.dsh-ig-speed-fill{bottom:0;height:var(--dsh-ig-speed-pct);background:var(--dsw-alias-state-business-primary,#3b6cf0)}
.dsh-ig-speed-one{position:absolute;left:7px;width:14px;height:2px;border-radius:1px;top:calc(var(--dsh-ig-speed-one) - 1px);background:rgba(127,127,127,0.55)}
.dsh-ig-speed-knob{corner-shape:round;position:absolute;left:4px;width:20px;height:20px;border-radius:50%;bottom:calc(var(--dsh-ig-speed-pct) - 10px);background:#fff;box-shadow:0 1px 4px rgba(15,23,42,0.35);pointer-events:none}
.dsh-ig-speed-track:focus-within .dsh-ig-speed-knob{box-shadow:0 0 0 3px rgba(59,108,240,0.45),0 1px 4px rgba(15,23,42,0.35)}
.dsh-ig-speed-input{position:absolute;inset:0;width:28px;height:150px;margin:0;opacity:0;writing-mode:vertical-lr;direction:rtl;cursor:pointer}
.dsh-ig-dl{position:relative;display:inline-flex}
.dsh-ig-dl-menu{position:absolute;top:calc(100% + 8px);left:0;width:236px;box-sizing:border-box;padding:6px;border-radius:12px;background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 10px 30px rgba(15,23,42,0.18),0 0 0 1px rgba(15,23,42,0.06);z-index:20;line-height:normal}
.dsh-ig-dl-lightbox .dsh-ig-dl-menu{left:auto;right:0;box-shadow:0 10px 30px rgba(0,0,0,0.4)}
.dsh-ig-dl-item{appearance:none;display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;min-height:44px;padding:8px 14px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:14px;text-align:left;cursor:pointer}
.dsh-ig-dl-item>span:first-child{font-weight:500}
.dsh-ig-dl-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f2f4f7)}
.dsh-ig-dl-item:disabled{opacity:.45;cursor:default}
.dsh-ig-dl-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99)}
/* The lightbox and the gallery preview are always dark: their menus stay light whatever the host theme. */
.dsh-ig-dl-lightbox .dsh-ig-dl-menu,.dsh-ig-dl-gallery .dsh-ig-dl-menu{background:#fff}
.dsh-ig-dl-lightbox .dsh-ig-dl-item,.dsh-ig-dl-gallery .dsh-ig-dl-item{color:#1f2329}
.dsh-ig-dl-lightbox .dsh-ig-dl-item:hover:not(:disabled),.dsh-ig-dl-gallery .dsh-ig-dl-item:hover:not(:disabled){background:#f2f4f7}
.dsh-ig-dl-lightbox .dsh-ig-dl-hint,.dsh-ig-dl-gallery .dsh-ig-dl-hint{color:#8a8f99}
.dsh-ig-gif-actions{position:absolute;top:20px;right:20px;display:flex;align-items:center;gap:10px;z-index:10}
.dsh-ig-gif-action{corner-shape:round;appearance:none;border:0;height:40px;min-width:40px;padding:0 12px;border-radius:999px;background:rgba(255,255,255,0.12);color:#fff;display:inline-flex;align-items:center;justify-content:center;gap:4px;font-size:13px;cursor:pointer}
.dsh-ig-gif-action:hover{background:rgba(255,255,255,0.22)}
.dsh-ig-gif-toast{position:absolute;top:72px;right:20px;font-size:12px;color:rgba(255,255,255,0.8);z-index:10}
.dsh-ig-gif-dock{position:absolute;bottom:28px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:stretch;gap:10px;max-width:calc(100vw - 48px);z-index:10;cursor:default}
.dsh-ig-gif-bar{corner-shape:round;display:flex;align-items:center;gap:10px;padding:6px;border-radius:999px;background:rgba(255,255,255,0.1);box-shadow:0 0 0 1px rgba(255,255,255,0.08);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-sizing:border-box;max-width:calc(100vw - 48px);color:#fff;line-height:normal}
/* No z-index: the gallery's bottom bar, later in the page, paints over this one, so its download menu opens on top. */
.dsh-ig-gif-bar-gallery{position:absolute;bottom:128px;left:50%;transform:translateX(-50%)}
.dsh-ig-gif-play{corner-shape:round;appearance:none;flex:none;width:44px;height:44px;border:0;border-radius:50%;background:#fff;color:#0d0f13;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.dsh-ig-gif-play:disabled{opacity:.5;cursor:default}
.dsh-ig-gif-bar .dsh-ig-speed-trigger{corner-shape:round;appearance:none;min-width:56px;height:44px;padding:0 12px;border:0;border-radius:999px;background:rgba(255,255,255,0.12);color:#fff;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer}
.dsh-ig-gif-bar .dsh-ig-speed-trigger:disabled{opacity:.5;cursor:default}
.dsh-ig-gif-strip{position:relative;flex:0 1 auto;width:350px;min-width:160px;height:44px;border-radius:8px;overflow:hidden;background:rgba(255,255,255,0.12);cursor:pointer;touch-action:none;outline:none}
.dsh-ig-gif-strip:focus-visible{box-shadow:0 0 0 2px #fff}
.dsh-ig-gif-strip[aria-disabled="true"]{cursor:default;animation:dsh-ig-gif-pulse 1.2s ease-in-out infinite}
.dsh-ig-gif-strip canvas{display:block;width:100%;height:100%}
.dsh-ig-gif-strip-head{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#5b8cff;pointer-events:none}
@keyframes dsh-ig-gif-pulse{50%{opacity:.6}}
/* The frame stays clear of the player bar under it: it is lifted by the bar's height and sized to fit above it. */
.dsh-ig-gif-wrap{position:relative;max-height:none;margin-bottom:108px}
.dsh-ig-gif-wrap .dsh-ig-lightbox-img{display:block;max-height:calc(100vh - 248px)}
.dsh-ig-gallery-gif-badge{position:absolute;left:10px;top:10px;padding:2px 7px;border-radius:6px;background:rgba(17,20,26,0.66);color:#fff;font-size:11px;font-weight:700;line-height:16px;letter-spacing:.3px;pointer-events:none;z-index:2;transition:opacity .15s ease}
.dsh-ig-gallery-card:hover .dsh-ig-gallery-gif-badge,.dsh-ig-gallery-card.is-manage-mode .dsh-ig-gallery-gif-badge,.dsh-ig-gallery-card.is-selected .dsh-ig-gallery-gif-badge{opacity:0}
.dsh-ig-gallery-gif-hover{position:absolute;inset:0;pointer-events:none}
.dsh-ig-lightbox-img.dsh-ig-gallery-gif-img{max-height:calc(100vh - 400px)}
.dsh-ig-dl-gallery .dsh-ig-dl-menu{top:auto;bottom:calc(100% + 8px);box-shadow:0 10px 30px rgba(0,0,0,0.4)}
.dsh-ig-dl-gallery svg{width:14px;height:14px}
`
