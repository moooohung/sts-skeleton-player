"use strict";

const align = (value, step) => Math.ceil(value / step) * step;
let sharedDevicePromise = null;

async function sharedDevice() {
  if (!sharedDevicePromise) {
    sharedDevicePromise = (async () => {
      if (!globalThis.navigator?.gpu) throw new Error("WebGPU unavailable");
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error("WebGPU adapter unavailable");
      const device = await adapter.requestDevice();
      const state = { adapter, device, lossListeners: new Set() };
      device.lost.then((info) => {
        if (sharedDevicePromise) sharedDevicePromise = null;
        for (const listener of state.lossListeners) listener(info);
        state.lossListeners.clear();
      });
      return state;
    })().catch((error) => { sharedDevicePromise = null; throw error; });
  }
  return sharedDevicePromise;
}

export async function createSkeletonWebGPU(canvas, {
  background = [0, 0, 0, 0],
  onDeviceLost = null,
} = {}) {
  const shared = await sharedDevice();
  const { device } = shared;
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("WebGPU canvas context unavailable");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: "premultiplied",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  let disposed = false;
  const lossListener = (info) => {
    if (!disposed) onDeviceLost?.(new Error(`WebGPU device lost: ${info?.message || info?.reason || "unknown"}`));
  };
  shared.lossListeners.add(lossListener);

  const projectionBuffer = device.createBuffer({
    label: "sts2-skel-projection",
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const projectionLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
  });
  const textureLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [projectionLayout, textureLayout] });
  const projectionBindGroup = device.createBindGroup({
    layout: projectionLayout,
    entries: [{ binding: 0, resource: { buffer: projectionBuffer } }],
  });

  const shaderSource = `
    override PMA: f32 = 0.0;
    struct Projection { value: mat4x4<f32> };
    @group(0) @binding(0) var<uniform> projection: Projection;
    @group(1) @binding(0) var atlasSampler: sampler;
    @group(1) @binding(1) var atlasTexture: texture_2d<f32>;

    struct VertexIn {
      @location(0) position: vec2<f32>,
      @location(1) uv: vec2<f32>,
      @location(2) light: vec4<f32>,
      @location(3) dark: vec3<f32>,
    };
    struct VertexOut {
      @builtin(position) position: vec4<f32>,
      @location(0) uv: vec2<f32>,
      @location(1) light: vec4<f32>,
      @location(2) dark: vec3<f32>,
    };
    @vertex fn vertexMain(input: VertexIn) -> VertexOut {
      var out: VertexOut;
      out.position = projection.value * vec4<f32>(input.position, 0.0, 1.0);
      out.uv = input.uv;
      out.light = input.light;
      out.dark = input.dark;
      return out;
    }
    @fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4<f32> {
      let t = textureSample(atlasTexture, atlasSampler, input.uv);
      let rgb = t.rgb * input.light.rgb + (vec3<f32>(mix(1.0, t.a, PMA)) - t.rgb) * input.dark;
      return vec4<f32>(rgb * mix(1.0, input.light.a, PMA), t.a * input.light.a);
    }
  `;
  const shader = device.createShaderModule({ label: "sts2-skel-wgsl", code: shaderSource });
  const vertexBuffers = [{
    arrayStride: 44,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },
      { shaderLocation: 1, offset: 8, format: "float32x2" },
      { shaderLocation: 2, offset: 16, format: "float32x4" },
      { shaderLocation: 3, offset: 32, format: "float32x3" },
    ],
  }];
  const blendState = (mode, pma) => {
    const source = pma ? "one" : "src-alpha";
    const color = {
      normal: { srcFactor: source, dstFactor: "one-minus-src-alpha" },
      additive: { srcFactor: source, dstFactor: "one" },
      multiply: { srcFactor: "dst", dstFactor: "one-minus-src-alpha" },
      screen: { srcFactor: "one", dstFactor: "one-minus-src" },
    }[mode];
    return {
      color: { ...color, operation: "add" },
      alpha: { srcFactor: "one", dstFactor: mode === "additive" ? "one" : "one-minus-src-alpha", operation: "add" },
    };
  };
  const pipelines = new Map();
  for (const pma of [false, true]) for (const mode of ["normal", "additive", "multiply", "screen"]) {
    pipelines.set(`${mode}:${pma ? 1 : 0}`, device.createRenderPipeline({
      label: `sts2-skel-${mode}-${pma ? "pma" : "straight"}`,
      layout: pipelineLayout,
      vertex: { module: shader, entryPoint: "vertexMain", buffers: vertexBuffers },
      fragment: {
        module: shader,
        entryPoint: "fragmentMain",
        constants: { PMA: pma ? 1 : 0 },
        targets: [{ format, blend: blendState(mode, pma) }],
      },
      primitive: { topology: "triangle-list" },
    }));
  }

  const sampler = device.createSampler({
    minFilter: "linear",
    magFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    maxAnisotropy: 8,
  });
  const mipSampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const mipShader = device.createShaderModule({
    label: "sts2-skel-mipmap-wgsl",
    code: `
      @group(0) @binding(0) var s: sampler;
      @group(0) @binding(1) var t: texture_2d<f32>;
      struct Out { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };
      @vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
        let p = array<vec2<f32>, 3>(vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
        let uv = array<vec2<f32>, 3>(vec2(0.0,1.0), vec2(2.0,1.0), vec2(0.0,-1.0));
        var o: Out; o.p = vec4(p[i], 0.0, 1.0); o.uv = uv[i]; return o;
      }
      @fragment fn fs(input: Out) -> @location(0) vec4<f32> { return textureSample(t, s, input.uv); }
    `,
  });
  const mipLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    ],
  });
  const mipPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [mipLayout] }),
    vertex: { module: mipShader, entryPoint: "vs" },
    fragment: { module: mipShader, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" },
  });

  const textures = new Map();
  async function loadTexture(page, image) {
    if (disposed) return;
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
    const texture = device.createTexture({
      label: `sts2-skel-atlas:${page.name}`,
      size: [width, height, 1],
      mipLevelCount,
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: image }, { texture, mipLevel: 0 }, [width, height]);
    if (mipLevelCount > 1) {
      const encoder = device.createCommandEncoder({ label: "sts2-skel-mipmap" });
      for (let level = 1; level < mipLevelCount; level++) {
        const sourceView = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
        const targetView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
        const bindGroup = device.createBindGroup({
          layout: mipLayout,
          entries: [{ binding: 0, resource: mipSampler }, { binding: 1, resource: sourceView }],
        });
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: targetView, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
        });
        pass.setPipeline(mipPipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
      }
      device.queue.submit([encoder.finish()]);
    }
    textures.get(page)?.texture.destroy();
    textures.set(page, {
      texture,
      bindGroup: device.createBindGroup({
        layout: textureLayout,
        entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: texture.createView() }],
      }),
    });
  }

  let vertexBuffer = null, vertexCapacity = 0, vertexData = new Float32Array(0);
  function ensureVertexCapacity(floatCount) {
    if (floatCount <= vertexCapacity) return;
    let capacity = Math.max(4096, vertexCapacity || 0);
    while (capacity < floatCount) capacity *= 2;
    vertexBuffer?.destroy();
    vertexBuffer = device.createBuffer({
      label: "sts2-skel-vertices",
      size: align(capacity * 4, 4),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    vertexData = new Float32Array(capacity);
    vertexCapacity = capacity;
  }

  const projection = new Float32Array(16);
  let projectionViewport = null;
  function render(commands, viewport, width, height, premultipliedAlpha = null) {
    if (disposed) return;
    const floats = commands.reduce((n, command) => n + command.vertices.length * 11, 0);
    ensureVertexCapacity(floats || 1);
    const batches = [];
    let used = 0, batch = null;
    const flush = () => {
      if (!batch) return;
      batch.count = used / 11 - batch.first;
      batches.push(batch);
      batch = null;
    };
    for (const command of commands) {
      const pma = premultipliedAlpha ?? command.page.pma;
      const texture = textures.get(command.page);
      if (!texture) continue;
      if (!batch || batch.page !== command.page || batch.mode !== command.blend || batch.pma !== pma) {
        flush();
        batch = { page: command.page, texture, mode: command.blend, pma, first: used / 11, count: 0 };
      }
      for (const vertex of command.vertices) {
        vertexData[used++] = vertex[0]; vertexData[used++] = vertex[1]; vertexData[used++] = vertex[2]; vertexData[used++] = vertex[3];
        vertexData[used++] = vertex[4] ?? command.light[0]; vertexData[used++] = vertex[5] ?? command.light[1]; vertexData[used++] = vertex[6] ?? command.light[2]; vertexData[used++] = vertex[7] ?? command.light[3];
        vertexData[used++] = vertex[8] ?? command.dark[0]; vertexData[used++] = vertex[9] ?? command.dark[1]; vertexData[used++] = vertex[10] ?? command.dark[2];
      }
    }
    flush();
    if (used) device.queue.writeBuffer(vertexBuffer, 0, vertexData.buffer, 0, used * 4);
    const v = viewport;
    if (!projectionViewport || projectionViewport[0] !== v.x || projectionViewport[1] !== v.y || projectionViewport[2] !== v.width || projectionViewport[3] !== v.height) {
    projection[0] = 2 / v.width; projection[1] = 0; projection[2] = 0; projection[3] = 0;
    projection[4] = 0; projection[5] = 2 / v.height; projection[6] = 0; projection[7] = 0;
    projection[8] = 0; projection[9] = 0; projection[10] = -.02; projection[11] = 0;
    // WebGPU clip-space depth is 0..1 (WebGL uses -1..1). The skeleton
    // vertices all have z=0, so keep them on WebGPU's near plane while
    // preserving the WebGL projection in X/Y.
    projection[12] = -1 - 2 * v.x / v.width; projection[13] = -1 - 2 * v.y / v.height;
    projection[14] = 0; projection[15] = 1;
    device.queue.writeBuffer(projectionBuffer, 0, projection);
    projectionViewport = [v.x, v.y, v.width, v.height];
    }
    const encoder = device.createCommandEncoder({ label: "sts2-skel-frame" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: background[0], g: background[1], b: background[2], a: background[3] },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setBindGroup(0, projectionBindGroup);
    if (used) pass.setVertexBuffer(0, vertexBuffer);
    for (const current of batches) {
      pass.setPipeline(pipelines.get(`${current.mode}:${current.pma ? 1 : 0}`));
      pass.setBindGroup(1, current.texture.bindGroup);
      pass.draw(current.count, 1, current.first);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  async function readPixels(width = canvas.width, height = canvas.height) {
    const bytesPerRow = align(width * 4, 256);
    const buffer = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: context.getCurrentTexture() },
      { buffer, bytesPerRow, rowsPerImage: height },
      [width, height, 1],
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange()), out = new Uint8Array(width * height * 4);
    const bgra = format.startsWith("bgra");
    for (let y = 0; y < height; y++) {
      const src = y * bytesPerRow, dst = y * width * 4;
      for (let x = 0; x < width; x++) {
        const i = src + x * 4, o = dst + x * 4;
        out[o] = mapped[i + (bgra ? 2 : 0)];
        out[o + 1] = mapped[i + 1];
        out[o + 2] = mapped[i + (bgra ? 0 : 2)];
        out[o + 3] = mapped[i + 3];
      }
    }
    buffer.unmap(); buffer.destroy();
    return out;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    shared.lossListeners.delete(lossListener);
    for (const { texture } of textures.values()) texture.destroy();
    textures.clear();
    vertexBuffer?.destroy();
    projectionBuffer.destroy();
    context.unconfigure();
  }

  return { device, format, loadTexture, render, readPixels, dispose };
}
