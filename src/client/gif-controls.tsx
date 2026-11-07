import { GifFilmstrip } from './gif-filmstrip.js'
import type { GifT } from './gif-i18n.js'
import { GifSpeedControl } from './gif-menus.js'
import { useGifPlaying, useGifStatus, type GifPlayer } from './gif-player.js'

interface GifPlayerBarProps {
  player: GifPlayer
  t: GifT
  /** Extra class for where the bar sits, e.g. above the gallery's own bottom bar. */
  className?: string | undefined
  /** The frame strip's tooltip, where its arrow keys mean something else around it. */
  stripHint?: string | undefined
}

/**
 * The lightbox player: play/pause, the frame strip and the speed. The bar is
 * in place from the first render; frame controls wait for decoded frames,
 * the speed only for the file's bytes, which a speed-named download retimes.
 */
export function GifPlayerBar({ player, t, className, stripHint }: GifPlayerBarProps) {
  const status = useGifStatus(player)
  const playing = useGifPlaying(player)
  const playLabel = playing ? t('gifPause') : t('gifPlay')
  return <div className={className === undefined ? 'dsh-ig-gif-bar' : `dsh-ig-gif-bar ${className}`} role="toolbar" aria-label={t('gifControls')} title={status === 'fallback' ? t('gifControlsUnavailable') : undefined} onClick={event => { event.stopPropagation() }}>
    <button type="button" className="dsh-ig-gif-play" aria-label={playLabel} title={playing ? t('gifPauseTitle') : t('gifPlayTitle')} disabled={status !== 'ready'} onClick={() => { player.toggle() }}>
      {playing
        ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
        : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.87l13-7.5a1 1 0 0 0 0-1.74l-13-7.5A1 1 0 0 0 7 4.5z" /></svg>}
    </button>
    <GifFilmstrip player={player} t={t} hint={stripHint} />
    <GifSpeedControl player={player} t={t} variant="bar" />
  </div>
}
