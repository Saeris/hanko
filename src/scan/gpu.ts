/**
 * GPU-accelerated transform scoring.
 *
 * One stage of this decoder is worth moving to the GPU and the rest are not.
 * Profiling a 1024x768 frame: binarization costs 16ms, blur 28ms, downscale
 * 6ms — all far too small to survive the cost of uploading a buffer,
 * dispatching a shader and reading the result back. But the corner search
 * makes **625 independent calls** to `scoreTransform` for about 179ms, which
 * is 78% of that stage and the largest single cost in the decoder.
 *
 * Those 625 calls score the same image under different transforms, share no
 * state, and each reads a few hundred pixels. That is the shape GPU compute
 * exists for: one upload of the image, 625 workgroups, one small readback.
 *
 * Availability is unusually good for a modern web API. WebGPU shipped
 * enabled-by-default in iOS 26, macOS Tahoe 26 and iPadOS 26, which removed
 * the last major holdout — so unlike `BarcodeDetector`, this is something the
 * target platforms actually have. It still degrades to the CPU path
 * everywhere else, because a scanner that only works on new hardware is not a
 * scanner.
 */

import type { BitMatrix } from "./types.js";
import type { Transform } from "./qr/sample.js";

/**
 * The scoring kernel.
 *
 * Mirrors `scoreTransform` exactly — same nine-point module sampling, same
 * ring structure, same weights. Any divergence would make GPU and CPU
 * disagree about which transform is best, which is worse than not
 * accelerating at all: results would depend on the device.
 */
const SHADER = `
struct Params {
  width: u32,
  height: u32,
  size: u32,
  centerCount: u32,
};

@group(0) @binding(0) var<storage, read> bits: array<u32>;
@group(0) @binding(1) var<storage, read> transforms: array<f32>;
@group(0) @binding(2) var<storage, read> centers: array<u32>;
@group(0) @binding(3) var<storage, read_write> scores: array<i32>;
@group(0) @binding(4) var<uniform> params: Params;

fn pixel(x: i32, y: i32) -> i32 {
  if (x < 0 || y < 0 || x >= i32(params.width) || y >= i32(params.height)) {
    return 0;
  }
  let index = u32(y) * params.width + u32(x);
  // Bits are packed one per u32 for simplicity: the readback is tiny and the
  // upload happens once per frame, so the memory is not the bottleneck.
  return select(-1, 1, bits[index] == 1u);
}

fn mapPoint(base: u32, x: f32, y: f32) -> vec2<f32> {
  let a11 = transforms[base + 0u];
  let a12 = transforms[base + 1u];
  let a13 = transforms[base + 2u];
  let a21 = transforms[base + 3u];
  let a22 = transforms[base + 4u];
  let a23 = transforms[base + 5u];
  let a31 = transforms[base + 6u];
  let a32 = transforms[base + 7u];
  let a33 = transforms[base + 8u];

  let w = a13 * x + a23 * y + a33;
  if (abs(w) < 1e-9) { return vec2<f32>(-1.0, -1.0); }
  return vec2<f32>((a11 * x + a21 * y + a31) / w, (a12 * x + a22 * y + a32) / w);
}

fn cell(base: u32, span: f32, mx: f32, my: f32) -> i32 {
  var score = 0;
  let offsets = array<f32, 3>(0.3, 0.5, 0.7);
  for (var v = 0u; v < 3u; v = v + 1u) {
    for (var u = 0u; u < 3u; u = u + 1u) {
      let p = mapPoint(base, (mx + offsets[u] - 3.5) / span, (my + offsets[v] - 3.5) / span);
      score = score + pixel(i32(round(p.x)), i32(round(p.y)));
    }
  }
  return score;
}

fn ring(base: u32, span: f32, cx: f32, cy: f32, radius: f32) -> i32 {
  var score = 0;
  let steps = i32(radius * 2.0);
  for (var i = 0; i < steps; i = i + 1) {
    let f = f32(i);
    score = score + cell(base, span, cx - radius + f, cy - radius);
    score = score + cell(base, span, cx - radius, cy + radius - f);
    score = score + cell(base, span, cx + radius, cy - radius + f);
    score = score + cell(base, span, cx + radius - f, cy + radius);
  }
  return score;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if (index >= arrayLength(&scores)) { return; }

  let base = index * 9u;
  let size = f32(params.size);
  let span = size - 7.0;
  var score = 0;

  // Timing patterns alternate; the expected value flips each module.
  for (var i = 0u; i < params.size - 14u; i = i + 1u) {
    let expected = select(-1, 1, (i & 1u) == 1u);
    score = score + cell(base, span, f32(i) + 7.0, 6.0) * expected;
    score = score + cell(base, span, 6.0, f32(i) + 7.0) * expected;
  }

  // Finders: dark centre, dark ring, light ring, dark ring.
  let corners = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(size - 7.0, 0.0),
    vec2<f32>(0.0, size - 7.0)
  );
  for (var c = 0u; c < 3u; c = c + 1u) {
    let x = corners[c].x + 3.0;
    let y = corners[c].y + 3.0;
    score = score + cell(base, span, x, y)
          + ring(base, span, x, y, 1.0)
          - ring(base, span, x, y, 2.0)
          + ring(base, span, x, y, 3.0);
  }

  // Alignment patterns: dark centre, light ring, dark ring.
  //
  // Two groups, matching the CPU exactly. The edge row and column come first
  // (skipping the last, which overlaps a finder), then the interior grid.
  // Scoring only the interior would give systematically different totals, and
  // since the whole technique ranks transforms against each other, GPU and
  // CPU would disagree about which corner is best — decoding that depends on
  // the device is worse than not accelerating at all.
  for (var i = 1u; i + 1u < params.centerCount; i = i + 1u) {
    let c = f32(centers[i]);
    score = score + cell(base, span, 6.0, c)
          - ring(base, span, 6.0, c, 1.0)
          + ring(base, span, 6.0, c, 2.0);
    score = score + cell(base, span, c, 6.0)
          - ring(base, span, c, 6.0, 1.0)
          + ring(base, span, c, 6.0, 2.0);
  }

  for (var i = 1u; i < params.centerCount; i = i + 1u) {
    for (var j = 1u; j < params.centerCount; j = j + 1u) {
      let cx = f32(centers[i]);
      let cy = f32(centers[j]);
      score = score + cell(base, span, cx, cy)
            - ring(base, span, cx, cy, 1.0)
            + ring(base, span, cx, cy, 2.0);
    }
  }

  scores[index] = score;
}
`;

/** Scores many transforms against one image, on the GPU. */
export interface GpuScorer {
  score(
    image: BitMatrix,
    transforms: readonly Transform[],
    size: number,
    alignmentCenters: readonly number[]
  ): Promise<Int32Array>;
  destroy(): void;
}

/** Whether this runtime exposes WebGPU at all. */
export const hasWebGpu = (): boolean =>
  typeof navigator === `object` && `gpu` in navigator;

/**
 * Create a GPU scorer, or `null` where WebGPU is unavailable.
 *
 * Returns `null` rather than throwing: every caller must have a CPU path
 * anyway, so an absent GPU is a normal condition and not an error.
 */
export const createGpuScorer = async (): Promise<GpuScorer | null> => {
  if (!hasWebGpu()) return null;

  // Narrowed through a runtime check rather than a cast: `navigator.gpu` is
  // absent on every server runtime and on older browsers.
  const gpu: unknown = (navigator as unknown as { gpu?: unknown }).gpu;
  if (typeof gpu !== `object` || gpu === null) return null;

  const adapter = await (
    gpu as { requestAdapter: () => Promise<unknown> }
  ).requestAdapter();
  if (adapter === null || typeof adapter !== `object`) return null;

  const device = await (
    adapter as { requestDevice: () => Promise<GpuDeviceLike> }
  ).requestDevice();

  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createComputePipeline({
    layout: `auto`,
    compute: { module, entryPoint: `main` }
  });

  return {
    score: async (image, transforms, size, alignmentCenters) => {
      const count = transforms.length;
      if (count === 0) return new Int32Array(0);

      // One u32 per pixel. Packing to bits would quarter the upload but adds
      // shifting in the inner loop, and the upload is not what costs here.
      const bits = new Uint32Array(image.bits.length);
      for (let i = 0; i < image.bits.length; i++) bits[i] = image.bits[i]!;

      const flat = new Float32Array(count * 9);
      for (const [index, transform] of transforms.entries()) {
        const base = index * 9;
        flat[base] = transform.a11;
        flat[base + 1] = transform.a12;
        flat[base + 2] = transform.a13;
        flat[base + 3] = transform.a21;
        flat[base + 4] = transform.a22;
        flat[base + 5] = transform.a23;
        flat[base + 6] = transform.a31;
        flat[base + 7] = transform.a32;
        flat[base + 8] = transform.a33;
      }

      const centers = Uint32Array.from(alignmentCenters);
      const params = new Uint32Array([
        image.width,
        image.height,
        size,
        centers.length
      ]);

      const upload = (data: ArrayBufferView, usage: number): GpuBufferLike => {
        const buffer = device.createBuffer({
          size: Math.max(4, data.byteLength),
          usage,
          mappedAtCreation: true
        });
        new Uint8Array(buffer.getMappedRange()).set(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        );
        buffer.unmap();
        return buffer;
      };

      const STORAGE = 0x80 | 0x4;
      const UNIFORM = 0x40 | 0x4;
      const COPY_SRC = 0x4;
      const COPY_DST = 0x8;
      const MAP_READ = 0x1;

      const bitsBuffer = upload(bits, STORAGE);
      const transformBuffer = upload(flat, STORAGE);
      const centerBuffer = upload(
        centers.length > 0 ? centers : new Uint32Array(1),
        STORAGE
      );
      const paramsBuffer = upload(params, UNIFORM);

      const scoreBuffer = device.createBuffer({
        size: count * 4,
        usage: 0x80 | COPY_SRC
      });
      const readBuffer = device.createBuffer({
        size: count * 4,
        usage: COPY_DST | MAP_READ
      });

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: bitsBuffer } },
          { binding: 1, resource: { buffer: transformBuffer } },
          { binding: 2, resource: { buffer: centerBuffer } },
          { binding: 3, resource: { buffer: scoreBuffer } },
          { binding: 4, resource: { buffer: paramsBuffer } }
        ]
      });

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
      encoder.copyBufferToBuffer(scoreBuffer, 0, readBuffer, 0, count * 4);
      device.queue.submit([encoder.finish()]);

      await readBuffer.mapAsync(MAP_READ);
      const scores = new Int32Array(readBuffer.getMappedRange().slice(0));
      readBuffer.unmap();

      for (const buffer of [
        bitsBuffer,
        transformBuffer,
        centerBuffer,
        paramsBuffer,
        scoreBuffer,
        readBuffer
      ]) {
        buffer.destroy();
      }

      return scores;
    },

    destroy: () => {
      device.destroy();
    }
  };
};

/**
 * The subset of WebGPU this module uses.
 *
 * Declared locally rather than pulled from a types package: this library ships
 * zero dependencies, and `@webgpu/types` would be one for a surface this
 * small.
 */
interface GpuBufferLike {
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
  mapAsync(mode: number): Promise<void>;
}

interface GpuDeviceLike {
  createShaderModule(descriptor: { code: string }): unknown;
  createComputePipeline(descriptor: {
    layout: string;
    compute: { module: unknown; entryPoint: string };
  }): { getBindGroupLayout(index: number): unknown };
  createBuffer(descriptor: {
    size: number;
    usage: number;
    mappedAtCreation?: boolean;
  }): GpuBufferLike;
  createBindGroup(descriptor: {
    layout: unknown;
    entries: Array<{ binding: number; resource: { buffer: GpuBufferLike } }>;
  }): unknown;
  createCommandEncoder(): {
    beginComputePass(): {
      setPipeline(pipeline: unknown): void;
      setBindGroup(index: number, group: unknown): void;
      dispatchWorkgroups(count: number): void;
      end(): void;
    };
    copyBufferToBuffer(
      source: GpuBufferLike,
      sourceOffset: number,
      destination: GpuBufferLike,
      destinationOffset: number,
      size: number
    ): void;
    finish(): unknown;
  };
  queue: { submit(buffers: unknown[]): void };
  destroy(): void;
}
