/**
 * Turning a camera into greyscale frames.
 *
 * The scanner in `@saeris/hanko/scan` is a pure decoder: pixels in, string
 * out. Acquiring those pixels — permissions, track constraints, the draw loop
 * — belongs to the application, and this is the smallest thing that does it.
 */

/** A running camera session. */
export interface Camera {
  /** Grab the current frame as greyscale, or `null` before the first paint. */
  grab(): { data: Uint8ClampedArray; width: number; height: number } | null;
  /** Stop the tracks and release the device. */
  stop(): void;
  /** What the browser actually gave us, which is rarely what was asked for. */
  readonly settings: MediaTrackSettings;
}

/**
 * Open the rear camera and start painting it into an offscreen canvas.
 *
 * `facingMode: environment` is a preference rather than a guarantee — a laptop
 * with one camera ignores it — so the caller is told what it actually got.
 */
export const openCamera = async (
  video: HTMLVideoElement,
  { width = 1280, height = 720 } = {}
): Promise<Camera> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: `environment` },
      width: { ideal: width },
      height: { ideal: height }
    },
    audio: false
  });

  video.srcObject = stream;
  video.setAttribute(`playsinline`, ``);
  await video.play();

  const canvas = document.createElement(`canvas`);
  // `willReadFrequently` matters here: without it the browser keeps the canvas
  // on the GPU and every `getImageData` is a synchronous readback, which is
  // the single most expensive thing in this loop.
  const context = canvas.getContext(`2d`, { willReadFrequently: true });
  if (context === null) throw new Error(`2d canvas is unavailable`);

  const [track] = stream.getVideoTracks();

  return {
    settings: track?.getSettings() ?? {},

    grab: () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w === 0 || h === 0) return null;

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      context.drawImage(video, 0, 0, w, h);
      const { data } = context.getImageData(0, 0, w, h);

      // Rec. 601 luma, matching the library's own `toGray`. Done here rather
      // than by shipping RGBA to the worker because it quarters the bytes
      // transferred per frame.
      const grey = new Uint8ClampedArray(w * h);
      for (let i = 0, p = 0; i < grey.length; i++, p += 4) {
        grey[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
      }

      return { data: grey, width: w, height: h };
    },

    stop: () => {
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    }
  };
};
