// LIVE SPECTROGRAM — a scrolling waterfall drawn from the audio you are actually
// hearing, one column per animation frame.
//
// Why this exists: the station panel used to poll /spectrogram.png, the PNG sox
// re-renders once per 15-second analysis cycle. That is a slideshow of stills,
// not a live instrument — "it's just like static" was the correct verdict. This
// reads the same stream the <audio> element is playing through an AnalyserNode
// and paints it continuously, so a bird call appears as you hear it.
//
// It draws ONLY while audio is genuinely playing. That is the honest contract:
// the picture is of the sound reaching you, so no sound means no new columns —
// never a synthesised idle animation implying the garden is being heard when
// nothing is arriving.
//
// AUDIO GRAPH CAUTION: MediaElementAudioSourceNode permanently re-routes the
// element. Once created, the element's sound only reaches the speakers through
// this graph — so the analyser MUST also connect to destination or playback goes
// silent while appearing to work. One source node per element, ever (a second
// one throws), hence the WeakMap.
import { useEffect, useRef } from 'react';
import './LiveSpectrogram.css';

/** One source node per media element, for the lifetime of the page. */
const SOURCES = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
let SHARED_CTX: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (SHARED_CTX) return SHARED_CTX;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  SHARED_CTX = new Ctor();
  return SHARED_CTX;
}

/** Frequencies above this carry almost nothing for birdsong at 24–48 kHz sample
 *  rates and would waste most of the band on empty air. Matches the 0–12 kHz
 *  axis sox draws for the recorded spectrograms. */
const MAX_HZ = 12_000;

export function LiveSpectrogram({
  audio,
  playing,
  height = 168,
}: {
  audio: HTMLAudioElement | null;
  playing: boolean;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // Build the graph once per element.
  useEffect(() => {
    if (!audio) return;
    const ctx = audioContext();
    if (!ctx) return;

    let source = SOURCES.get(audio);
    if (!source) {
      try {
        source = ctx.createMediaElementSource(audio);
        SOURCES.set(audio, source);
      } catch {
        return; // already routed elsewhere; leave playback alone
      }
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.5;
    analyser.minDecibels = -95;
    analyser.maxDecibels = -20;
    source.connect(analyser);
    // The speaker path. Without this the element plays into the void.
    analyser.connect(ctx.destination);
    analyserRef.current = analyser;

    return () => {
      try {
        analyser.disconnect();
      } catch {
        /* already torn down */
      }
      analyserRef.current = null;
    };
  }, [audio]);

  // Paint loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext('2d', { alpha: false });
    if (!g) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 600;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(height * dpr);

    // Ground colour comes from the theme so the band matches .bp-spectro.
    const ground = getComputedStyle(canvas).getPropertyValue('--spec-ground').trim() || '#141414';
    g.fillStyle = ground;
    g.fillRect(0, 0, canvas.width, canvas.height);

    if (!playing) return; // no sound reaching us → no new columns. Deliberate.

    const ctx = SHARED_CTX;
    let bins = 0;
    let data = new Uint8Array(0);

    const draw = () => {
      const analyser = analyserRef.current;
      if (!analyser || !ctx) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      if (bins !== analyser.frequencyBinCount) {
        bins = analyser.frequencyBinCount;
        data = new Uint8Array(bins);
      }
      analyser.getByteFrequencyData(data);

      const w = canvas.width;
      const h = canvas.height;
      const col = Math.max(1, Math.floor(dpr));

      // Scroll left by one column, then paint the newest slice on the right.
      g.drawImage(canvas, -col, 0);
      g.fillStyle = ground;
      g.fillRect(w - col, 0, col, h);

      // Only the bins below MAX_HZ, mapped bottom-up so low frequencies sit at
      // the bottom exactly as they do in the sox plots.
      const nyquist = ctx.sampleRate / 2;
      const top = Math.min(bins, Math.ceil((MAX_HZ / nyquist) * bins));
      for (let y = 0; y < h; y++) {
        const frac = 1 - y / h;
        const bin = Math.min(top - 1, Math.floor(frac * top));
        const v = data[bin] / 255;
        if (v <= 0.02) continue; // leave the ground showing, don't smear grey
        // Greyscale traces, warming to amber at the loudest — the museum's ink.
        const l = Math.round(30 + v * 225);
        g.fillStyle = v > 0.82 ? `rgb(${l},${Math.round(l * 0.78)},${Math.round(l * 0.45)})` : `rgb(${l},${l},${l})`;
        g.fillRect(w - col, y, col, 1);
      }
      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, height]);

  return <canvas ref={canvasRef} className="live-spec" style={{ height }} aria-label="Live spectrogram of the garden microphone" />;
}
