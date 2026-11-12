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
/* The lightbox is always dark, so its accents use a fixed blue: the host's brand colour is neutral (near-black, or near-white in its dark theme). */
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
.dsh-ig-gif-strip-mark{corner-shape:round;position:absolute;top:3px;width:7px;height:7px;margin-left:-3.5px;border-radius:50%;background:#5b8cff;box-shadow:0 0 0 1.5px #fff;pointer-events:none}
/* The frame stays clear of the bars under it: it is lifted by their measured height (--dsh-ig-gif-dock-h) and sized to fit above them. */
.dsh-ig-gif-wrap{position:relative;max-height:none;margin-bottom:calc(var(--dsh-ig-gif-dock-h,56px) + 52px)}
.dsh-ig-gif-wrap .dsh-ig-lightbox-img,.dsh-ig-gif-sheet{display:block;max-height:calc(100vh - var(--dsh-ig-gif-dock-h,56px) - 192px)}
.dsh-ig-gif-wrap.is-editing{border-radius:10px;box-shadow:0 0 0 3px #3b6cf0}
.dsh-ig-gif-wrap.is-sheet .dsh-ig-gif-stage{position:absolute;inset:0;overflow:hidden;opacity:0;pointer-events:none}
.dsh-ig-gif-sheet{display:block;max-width:86vw;border-radius:10px;background:#1b1e24}
.dsh-ig-gif-edit-chip-slot{position:absolute;right:12px;bottom:12px;z-index:3;line-height:normal}
.dsh-ig-container:has(.dsh-ig-version-nav) .dsh-ig-gif-edit-chip-slot{bottom:48px}
.dsh-ig-gif-edit-chip{display:inline-flex;align-items:center;gap:6px;padding:0 12px}
.dsh-ig-gif-edit-toggle{corner-shape:round;appearance:none;flex:none;height:44px;padding:0 18px;border-radius:999px;border:1.5px solid rgba(255,255,255,0.45);background:transparent;color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.dsh-ig-gif-edit-toggle.is-active{background:#3b6cf0;border-color:#3b6cf0}
.dsh-ig-gif-edit-toggle:disabled{opacity:.5;cursor:default}
/* The edit bar takes the player bar's width rather than widening it, and wraps its text. */
.dsh-ig-gif-edit{contain:inline-size;box-sizing:border-box;padding:10px 12px;border-radius:14px;background:rgba(255,255,255,0.08);color:#fff;display:grid;gap:8px;line-height:normal}
.dsh-ig-gif-edit-hint{margin:0;font-size:12px;line-height:1.45;color:rgba(255,255,255,0.6)}
.dsh-ig-gif-edit-row{display:flex;align-items:center;gap:8px}
.dsh-ig-gif-edit-counter{flex:1;min-width:0;font-size:13px;color:rgba(255,255,255,0.85);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ig-gif-view{corner-shape:round;display:flex;flex:none;padding:3px;border-radius:999px;background:rgba(255,255,255,0.08)}
.dsh-ig-gif-view button{corner-shape:round;appearance:none;height:32px;padding:0 12px;border:0;border-radius:999px;background:transparent;font:inherit;font-size:13px;color:rgba(255,255,255,0.7);cursor:pointer}
.dsh-ig-gif-view button[aria-pressed="true"]{background:rgba(255,255,255,0.18);color:#fff;font-weight:600}
.dsh-ig-gif-edit-ghost,.dsh-ig-gif-edit-send{corner-shape:round;appearance:none;flex:none;height:36px;border-radius:999px;font:inherit;font-size:13px;cursor:pointer}
.dsh-ig-gif-edit-ghost{padding:0 12px;border:1px solid rgba(255,255,255,0.25);background:transparent;color:#fff}
.dsh-ig-gif-edit-send{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 14px;border:0;background:#3b6cf0;color:#fff;font-weight:600;font-variant-numeric:tabular-nums}
.dsh-ig-gif-edit-ghost:disabled,.dsh-ig-gif-edit-send:disabled{opacity:.5;cursor:default}
/* A send in progress stays readable: it counts the seconds. */
.dsh-ig-gif-edit-send.is-busy:disabled{opacity:.8}
.dsh-ig-gif-edit-notice,.dsh-ig-gif-edit-error{display:grid;gap:6px;justify-items:start;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.dsh-ig-gif-edit-notice{margin:6px 0;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,0.05));color:var(--dsw-alias-label-secondary,inherit)}
.dsh-ig-gif-edit-error{background:rgba(239,68,68,0.16);color:#fca5a5}
/* Over the picture while an edit is sent, above the pins and note boxes, which wait for it. */
.dsh-ig-gif-edit-busy{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;border-radius:10px;background:rgba(13,15,19,0.6);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);color:#fff;line-height:normal;cursor:default;animation:dsh-ig-gif-fade .18s ease-out}
.dsh-ig-gif-edit-busy-spinner,.dsh-ig-gif-edit-spinner{corner-shape:round;flex:none;box-sizing:border-box;border:2px solid rgba(255,255,255,0.25);border-top-color:#fff;border-radius:50%;animation:dsh-ig-gif-spin .8s linear infinite}
.dsh-ig-gif-edit-busy-spinner{width:32px;height:32px;border-width:3px}
.dsh-ig-gif-edit-spinner{width:14px;height:14px}
.dsh-ig-gif-edit-busy-text{font-size:14px;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,0.4)}
.dsh-ig-gif-edit-busy-track{corner-shape:round;width:min(200px,60%);height:4px;border-radius:2px;background:rgba(255,255,255,0.18);overflow:hidden}
/* The estimate moves once a second; gliding for that second makes it read as steady progress. */
.dsh-ig-gif-edit-busy-fill{display:block;height:100%;background:#5b8cff;transform-origin:left;transition:transform 1s linear}
/* The reply is in: the bar fills within GIF_EDIT_FINISH_MS, and the overlay stays until the new version is filed. */
.dsh-ig-gif-edit-busy.is-finishing .dsh-ig-gif-edit-busy-fill{transition:transform .3s ease-out}
.dsh-ig-gif-edit-done-text{margin:0;font-size:13px;line-height:1.5}
.dsh-ig-gif-edit-row.is-end{justify-content:flex-end}
/* The plain preview has no player bar for the finished edit's bar to take its width from, and keeps the picture clear of it. */
.dsh-ig-gif-dock.is-plain{width:min(560px,calc(100vw - 48px))}
.dsh-ig-lightbox-backdrop:has(>.dsh-ig-gif-dock.is-plain) .dsh-ig-lightbox-img{max-height:calc(100vh - 320px)}
/* The previews swap while a finished edit's new version loads; replaying their entrance would flash the page behind them. */
.dsh-ig-lightbox-backdrop:has(.dsh-ig-gif-edit.is-done){animation:none}
@keyframes dsh-ig-gif-spin{to{transform:rotate(360deg)}}
@keyframes dsh-ig-gif-fade{from{opacity:0}}
@media(prefers-reduced-motion:reduce){.dsh-ig-gif-edit-busy,.dsh-ig-gif-edit-busy *,.dsh-ig-gif-edit-spinner{animation:none!important;transition:none!important}}
/* The cursor is the pin it places, its sharp corner on the point, as ChatGPT draws it. */
.dsh-ig-gif-edit-layer{position:absolute;inset:0;z-index:3;margin:0;padding:0;border:0;border-radius:10px;background:transparent;cursor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M2 22V12A10 10 0 0 1 22 12A10 10 0 0 1 12 22Z' fill='%233b6cf0' stroke='white' stroke-width='1.5'/%3E%3C/svg%3E") 2 22,crosshair}
/* While a note is being written, a click on the picture only closes it, so the cursor is the plain one. */
.dsh-ig-gif-wrap:has(.dsh-ig-gif-note.is-new,.dsh-ig-gif-note.is-edit) :is(.dsh-ig-gif-edit-layer,.dsh-ig-gif-sheet-cell){cursor:default}
.dsh-ig-gif-edit-layer:focus-visible{outline:2px solid #fff;outline-offset:-2px}
.dsh-ig-gif-sheet-cell{position:absolute;z-index:3;box-sizing:border-box;margin:0;padding:0;border:0;background:transparent;outline:1px solid #0d0f13;outline-offset:-1px;cursor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M2 22V12A10 10 0 0 1 22 12A10 10 0 0 1 12 22Z' fill='%233b6cf0' stroke='white' stroke-width='1.5'/%3E%3C/svg%3E") 2 22,crosshair}
.dsh-ig-gif-sheet-cell.is-current{outline:2px solid #3b6cf0;outline-offset:-2px}
.dsh-ig-gif-sheet-cell.is-blank{cursor:default;background:#1b1e24}
.dsh-ig-gif-sheet-cell:focus-visible{outline:2px solid #fff;outline-offset:-2px}
.dsh-ig-gif-sheet-cell span{position:absolute;left:4px;top:4px;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,0.6);color:#fff;font-size:11px;font-weight:600;line-height:1.4;pointer-events:none}
.dsh-ig-gif-pin{corner-shape:round;position:absolute;z-index:4;min-width:28px;height:28px;margin:-28px 0 0;box-sizing:border-box;padding:0 7px;border:2px solid #fff;border-radius:14px 14px 14px 0;background:#3b6cf0;color:#fff;font:inherit;font-size:13px;font-weight:700;line-height:24px;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer}
.dsh-ig-gif-pin.is-small{min-width:20px;height:20px;margin-top:-20px;padding:0 4px;border-width:1.5px;border-radius:10px 10px 10px 0;font-size:11px;line-height:17px}
.dsh-ig-gif-pin.is-active{box-shadow:0 0 0 3px rgba(59,108,240,0.55),0 2px 6px rgba(0,0,0,0.4)}
.dsh-ig-gif-pin.is-draft{pointer-events:none}
.dsh-ig-gif-note{corner-shape:round;position:absolute;z-index:5;width:292px;max-width:calc(100vw - 32px);box-sizing:border-box;background:#2f2f2f;color:#fff;box-shadow:0 12px 32px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.1);transform:translate(30px,-36px);line-height:normal;cursor:default}
.dsh-ig-gif-note:focus{outline:none}
.dsh-ig-gif-note.is-left{transform:translate(calc(-100% - 8px),-36px)}
.dsh-ig-gif-note.is-up{transform:translate(30px,calc(-100% + 8px))}
.dsh-ig-gif-note.is-left.is-up{transform:translate(calc(-100% - 8px),calc(-100% + 8px))}
.dsh-ig-gif-note.is-new{height:44px;display:flex;align-items:center;gap:8px;padding:0 4px 0 18px;border-radius:999px}
.dsh-ig-gif-note.is-edit{padding:4px 6px 6px 16px;border-radius:22px}
.dsh-ig-gif-note.is-view{min-height:44px;display:flex;align-items:center;padding:10px 18px;border-radius:22px}
.dsh-ig-gif-note.is-view p{margin:0;flex:1;font-size:15px;line-height:1.5;word-break:break-word}
.dsh-ig-gif-note-field{height:40px;display:flex;align-items:center}
.dsh-ig-gif-note-input{flex:1;min-width:0;width:100%;height:36px;margin:0;padding:0;border:0;outline:0;background:transparent;color:#fff;font:inherit;font-size:15px}
.dsh-ig-gif-note-input::placeholder{color:rgba(255,255,255,0.5)}
.dsh-ig-gif-note-actions{display:flex;align-items:center;gap:6px}
.dsh-ig-gif-note-actions span{flex:1}
.dsh-ig-gif-note-icon,.dsh-ig-gif-note-post{corner-shape:round;appearance:none;flex:none;width:36px;height:36px;margin:0;padding:0;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer}
.dsh-ig-gif-note-icon{margin-left:-8px;background:transparent;color:#fff}
.dsh-ig-gif-note-icon:hover{background:rgba(255,255,255,0.1)}
.dsh-ig-gif-note-post{background:#fff;color:#1f2329}
.dsh-ig-gif-note-post:disabled{background:#8a8a8a;color:#2f2f2f;cursor:default}
.dsh-ig-gif-note-ghost,.dsh-ig-gif-note-save{corner-shape:round;appearance:none;flex:none;height:36px;border-radius:999px;font:inherit;font-size:14px;cursor:pointer}
.dsh-ig-gif-note-ghost{padding:0 14px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:#fff}
.dsh-ig-gif-note-save{padding:0 16px;border:0;background:#fff;color:#1f2329;font-weight:600}
.dsh-ig-gif-note-save:disabled{opacity:.45;cursor:default}
.dsh-ig-gallery-gif-badge{position:absolute;left:10px;top:10px;padding:2px 7px;border-radius:6px;background:rgba(17,20,26,0.66);color:#fff;font-size:11px;font-weight:700;line-height:16px;letter-spacing:.3px;pointer-events:none;z-index:2;transition:opacity .15s ease}
.dsh-ig-gallery-card:hover .dsh-ig-gallery-gif-badge,.dsh-ig-gallery-card.is-manage-mode .dsh-ig-gallery-gif-badge,.dsh-ig-gallery-card.is-selected .dsh-ig-gallery-gif-badge{opacity:0}
.dsh-ig-gallery-gif-hover{position:absolute;inset:0;pointer-events:none}
.dsh-ig-lightbox-img.dsh-ig-gallery-gif-img{max-height:calc(100vh - 400px)}
.dsh-ig-dl-gallery .dsh-ig-dl-menu{top:auto;bottom:calc(100% + 8px);box-shadow:0 10px 30px rgba(0,0,0,0.4)}
.dsh-ig-dl-gallery svg{width:14px;height:14px}
`
