/**
 * SyncController — Master Audio/Video Synchronization
 *
 * El video actúa como el master clock.
 * El audio se ajusta periódicamente si hay drift > threshold.
 * Todos los controles de reproducción pasan por este controlador.
 */

(function () {
  'use strict';

  class SyncController {
    /**
     * @param {HTMLVideoElement} videoEl
     * @param {HTMLAudioElement} audioEl
     * @param {number} driftThreshold — segundos de tolerancia antes de corregir
     */
    constructor(videoEl, audioEl, driftThreshold = 0.15) {
      this.video = videoEl;
      this.audio = audioEl;
      this.driftThreshold = driftThreshold;
      this.isReady = false;
      this.syncInterval = null;
      this.SYNC_CHECK_MS = 1000; // Revisar sync cada 1 segundo
      this._listeners = {};
      this._correcting = false;

      this._bindVideoEvents();
    }

    // ── SETUP ────────────────────────────────────────────────

    _bindVideoEvents() {
      // Cuando el video carga suficiente para reproducir
      this.video.addEventListener('canplay', () => {
        this.isReady = true;
        this._emit('ready');
      });

      // Sincronizar pausa cuando el video se pausa externamente
      this.video.addEventListener('pause', () => {
        if (!this.audio.paused) {
          this.audio.pause();
        }
        this._stopSyncCheck();
        this._emit('pause');
      });

      // Sincronizar play cuando el video reanuda externamente
      this.video.addEventListener('play', () => {
        this._syncAudioToVideo();
        this.audio.play().catch(() => {});
        this._startSyncCheck();
        this._emit('play');
      });

      // Cuando el usuario hace seeking en el video
      this.video.addEventListener('seeking', () => {
        this._correcting = true;
      });

      this.video.addEventListener('seeked', () => {
        this._syncAudioToVideo();
        this._correcting = false;
        this._emit('seeking');
      });

      // Fin de reproducción
      this.video.addEventListener('ended', () => {
        this.audio.pause();
        this._stopSyncCheck();
        this._emit('ended');
      });

      // Timeupdate (para el reproductor)
      this.video.addEventListener('timeupdate', () => {
        this._emit('timeupdate', {
          currentTime: this.video.currentTime,
          duration: this.video.duration || 0
        });
      });

      // Error de video
      this.video.addEventListener('error', (e) => {
        console.warn('[SyncController] Video error:', e);
        this._emit('error', { source: 'video', event: e });
      });

      // Error de audio
      this.audio.addEventListener('error', (e) => {
        console.warn('[SyncController] Audio error:', e);
        this._emit('error', { source: 'audio', event: e });
      });
    }

    // ── CONTROL PRINCIPAL ────────────────────────────────────

    /**
     * Inicia la reproducción desde 0 (o desde un timestamp específico).
     * Llama esto al hacer click en "ENTRAR".
     */
    async play(fromTime = 0) {
      this.video.currentTime = fromTime;
      this.audio.currentTime = fromTime;

      try {
        // Intentar reproducir video con audio (en algunos navegadores funciona)
        this.video.muted = true; // El audio va por elemento separado
        await this.video.play();
        await this.audio.play();
        this._startSyncCheck();
        this._emit('play');
        return true;
      } catch (err) {
        console.warn('[SyncController] Play blocked:', err.message);
        this._emit('playBlocked', err);
        return false;
      }
    }

    pause() {
      this.video.pause();
      this.audio.pause();
      this._stopSyncCheck();
      this._emit('pause');
    }

    resume() {
      const currentTime = this.video.currentTime;
      this.audio.currentTime = currentTime;
      this.video.play().catch(() => {});
      this.audio.play().catch(() => {});
      this._startSyncCheck();
      this._emit('play');
    }

    toggle() {
      if (this.video.paused) {
        this.resume();
      } else {
        this.pause();
      }
    }

    seek(time) {
      this.video.currentTime = time;
      this.audio.currentTime = time;
    }

    restart() {
      this.seek(0);
      this.resume();
    }

    get isPlaying() {
      return !this.video.paused;
    }

    get currentTime() {
      return this.video.currentTime;
    }

    get duration() {
      return this.video.duration || this.audio.duration || 0;
    }

    // ── VOLUMEN ──────────────────────────────────────────────

    setVolume(v) {
      const vol = Math.min(1, Math.max(0, v));
      this.audio.volume = vol;
      this._emit('volumechange', { volume: vol, muted: this.audio.muted });
    }

    get volume() {
      return this.audio.volume;
    }

    mute() {
      this.audio.muted = true;
      this._emit('volumechange', { volume: this.audio.volume, muted: true });
    }

    unmute() {
      this.audio.muted = false;
      this._emit('volumechange', { volume: this.audio.volume, muted: false });
    }

    toggleMute() {
      if (this.audio.muted) {
        this.unmute();
      } else {
        this.mute();
      }
      return this.audio.muted;
    }

    get isMuted() {
      return this.audio.muted;
    }

    // ── SYNC CHECK ───────────────────────────────────────────

    _startSyncCheck() {
      this._stopSyncCheck();
      this.syncInterval = setInterval(() => {
        this._checkDrift();
      }, this.SYNC_CHECK_MS);
    }

    _stopSyncCheck() {
      if (this.syncInterval) {
        clearInterval(this.syncInterval);
        this.syncInterval = null;
      }
    }

    _checkDrift() {
      if (this._correcting || this.video.paused || this.audio.paused) return;

      const drift = Math.abs(this.video.currentTime - this.audio.currentTime);

      if (drift > this.driftThreshold) {
        console.debug(`[SyncController] Drift ${drift.toFixed(3)}s → correcting`);
        this._syncAudioToVideo();
      }
    }

    _syncAudioToVideo() {
      if (Math.abs(this.audio.currentTime - this.video.currentTime) > 0.05) {
        this.audio.currentTime = this.video.currentTime;
      }
    }

    // ── EVENTOS ──────────────────────────────────────────────

    on(event, callback) {
      if (!this._listeners[event]) {
        this._listeners[event] = [];
      }
      this._listeners[event].push(callback);
      return this; // Encadenable
    }

    off(event, callback) {
      if (this._listeners[event]) {
        this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
      }
    }

    _emit(event, data) {
      if (this._listeners[event]) {
        this._listeners[event].forEach(cb => {
          try { cb(data); } catch (e) { console.warn('[SyncController] Listener error:', e); }
        });
      }
    }

    destroy() {
      this._stopSyncCheck();
      this._listeners = {};
    }
  }

  // Exponer globalmente
  window.SyncController = SyncController;

})();
