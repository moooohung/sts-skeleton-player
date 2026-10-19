# sts-skeleton-player

Original browser skeletal-animation player for the publicly documented Spine 4.2 binary skeleton and atlas formats. Written independently using format and runtime documentation, mathematics and public-API black-box observations. See [cleanroom_log.md](cleanroom_log.md).

## Files

| File | Role |
|---|---|
| `skelplayer.js` | Binary/atlas parser, skeleton pose, animation state and the WebGL / Canvas2D renderers |
| `skelgpu.js` | WebGPU backend (ES module, loaded on demand), with automatic fallback to WebGL, then Canvas2D |
| `skelcompat.js` | Compatibility probe: says *before* playback whether an export is supported, and why not |
| `probe_compatibility.cjs` | Command-line probe: `node probe_compatibility.cjs <file.skel> <file.atlas>` (or `--stdin` JSON lines) |

## Features

- **Attachments:** regions, weighted/linked meshes, deform, skins, sequences (all seven modes), clipping (including degenerate polygons).
- **Bones and constraints:** five inheritance modes, IK, transform, path and physics constraints. Physics covers the none/reset/update/pose modes and reset timelines.
- **Timelines:** bone, slot (including two-colour tint), attachment, draw order and events, with mixing thresholds.
- **AnimationState:**
  - tracks, layering and queues
  - mix duration and pair mixes, interruption chains
  - `holdPrevious`, all four `MixBlend` modes, track alpha
  - entry and state time scales, track end, animation start/end/last, reverse
  - shortest rotation, empty animations, clear without pose reset
  - start/interrupt/end/dispose/complete/event listeners
- **Rendering:** WebGPU and WebGL with tint/dark tint, four blend modes, straight or premultiplied alpha, and vertex-effect hooks. Canvas2D is an approximate fallback.

Unknown or newer binary layouts, unknown attachment types and corrupt sequence metadata fail closed with an explicit reason. JSON skeleton inspection is supported; JSON playback is not, and is reported as unsupported.

## Verification

- Tests: `node --test skelplayer_test.cjs skelcompat_test.cjs skelbatch_test.cjs` (81 tests). All fixtures are authored synthetic data.
- The 2026-10-10 source-matched black-box matrix passed 1,810/1,810 eligible canonical cases across 853,822 compared frames. It covered 177 served skeleton paths of the exact Spine 4.2 export family (4.2.03–4.2.43) observed in the shipping game and its mods. The 2026-10-19 AnimationState, physics, sequence and clipping additions are covered by the synthetic tests above.
- The published repository contains no game assets, extracted data, generated game metadata, screenshots, third-party runtime files, parity receipts or site history.

Copyright (c) 2026 moooohung. All rights reserved. No permission to use, copy, modify or redistribute is granted except by prior written permission. Source visibility grants no license. See [LICENSE](LICENSE).
