# Clean-room record

Date: 2026-10-09 (Asia/Seoul). This original runtime was authored from public file-format documentation, general graphics mathematics, exported input data, and numeric/rendered observations from an authorized official-player black-box oracle. No official or derived runtime source, bundle, cache, shader source, decompiled game wrapper, or plugin implementation was read, searched, copied, or incorporated.

The oracle executed only in a local test harness. Named public APIs supplied bone/slot poses, world vertices, events, clipping outputs and rendered frames. Standard WebGL APIs additionally captured generated numeric vertex/index buffers and attribute/blend metadata. These observations contained no executable code or shader text. No function bodies or implementation internals were inspected. Input data and local screenshots are excluded from this repository. Unit fixtures are original synthetic data.

spine2d licensing/provenance and browser-fit documentation was evaluated separately. Its independent provenance was not established under the project's strict gate. No implementation, tests, build or wasm was consulted or used. These evaluation documents were not implementation inputs.

External documentation/provenance sources consulted (each accessed 2026-10-09):

- https://esotericsoftware.com/spine-json-format
- https://esotericsoftware.com/spine-binary-format
- https://esotericsoftware.com/spine-atlas-format
- https://chromedevtools.github.io/devtools-protocol/tot/Performance/
- https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate
- https://raw.githubusercontent.com/Latias94/spine2d/main/assets/README.md
- https://raw.githubusercontent.com/Latias94/spine2d/main/Cargo.toml
- https://raw.githubusercontent.com/Latias94/spine2d/main/CHANGELOG.md
- https://raw.githubusercontent.com/Latias94/spine2d/main/docs/decisions.md
- https://raw.githubusercontent.com/Latias94/spine2d/main/docs/parity.md
- https://raw.githubusercontent.com/Latias94/spine2d/main/docs/roadmap.md
- https://api.github.com/repos/Latias94/spine2d/git/trees/main?recursive=1
- https://raw.githubusercontent.com/Latias94/spine2d/main/LICENSE-APACHE
- https://raw.githubusercontent.com/Latias94/spine2d/main/LICENSE-MIT
- https://raw.githubusercontent.com/Latias94/spine2d/main/README.md
- https://raw.githubusercontent.com/Latias94/spine2d/main/spine2d-web/Cargo.toml
- https://raw.githubusercontent.com/Latias94/spine2d/main/spine2d/Cargo.toml
- https://raw.githubusercontent.com/Latias94/spine2d/main/spine2d/tests/golden/SOURCE.txt
- https://raw.githubusercontent.com/Latias94/spine2d/main/third_party/README.md
- https://raw.githubusercontent.com/Latias94/spine2d/v0.2.0/assets/README.md
- https://raw.githubusercontent.com/Latias94/spine2d/v0.2.0/Cargo.toml
- https://raw.githubusercontent.com/Latias94/spine2d/v0.2.0/CHANGELOG.md
- https://api.github.com/repos/Latias94/spine2d/git/trees/v0.2.0?recursive=1
- https://raw.githubusercontent.com/Latias94/spine2d/v0.2.0/LICENSE-APACHE
- https://raw.githubusercontent.com/Latias94/spine2d/v0.2.0/LICENSE-MIT
- https://raw.githubusercontent.com/Latias94/spine2d/v0.2.0/README.md
- https://raw.githubusercontent.com/Latias94/spine2d/v0.2.0/spine2d-web/Cargo.toml
- https://raw.githubusercontent.com/Latias94/spine2d/v0.2.0/spine2d/Cargo.toml
- https://raw.githubusercontent.com/Latias94/spine2d/v0.2.0/spine2d/tests/golden/SOURCE.txt
- https://raw.githubusercontent.com/Latias94/spine2d/v0.2.0/third_party/README.md
- https://api.github.com/repos/Latias94/spine2d
- https://crates.io/api/v1/crates/spine2d/0.2.0
- https://docs.rs/crate/spine2d/0.2.0
- https://github.com/Latias94/spine2d/releases
- https://github.com/Latias94/spine2d
- https://api.github.com/repos/Latias94/spine2d/commits?per_page=100&page=1
- https://api.github.com/repos/Latias94/spine2d/commits?per_page=100&page=2
- https://api.github.com/repos/Latias94/spine2d/commits?per_page=100&page=3
- https://api.github.com/repos/Latias94/spine2d/commits?per_page=100&page=4
- https://registry.npmjs.org/@playwright%2fcli
- https://registry.npmjs.org/@esotericsoftware%2fspine-player
- https://api.github.com/repos/nodejs/node/releases/latest

Additional documentation entries from the private dated record (accessed 2026-10-09):

- https://github.com/microsoft/playwright-cli/blob/main/README.md
- https://github.com/microsoft/playwright-cli/blob/main/skills/playwright-cli/references/running-code.md
- https://github.com/microsoft/playwright.dev/blob/main/nodejs/docs/mock.mdx
- https://github.com/microsoft/playwright/blob/main/docs/src/api/class-route.md
- https://github.com/microsoft/playwright/blob/main/docs/src/network.md
- https://github.com/microsoft/playwright/blob/main/docs/src/api/class-page.md
- https://github.com/microsoft/playwright/blob/main/docs/src/evaluating.md
- https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/client/locator.ts
- https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crPage.ts

Final publication gate (2026-10-10): the source-matched black-box matrix passes 1,810/1,810 eligible canonical cases over 853,822 compared frames, with zero pending cases. The official player was used only through its public API and rendered output; its runtime source or bundle was never read or searched. Exactly three malformed original exports that the official player also cannot play are excluded as broken inputs. Game comparison screenshots and all local parity receipts remain private and are not part of this repository. No runtime implementation code was consulted.

## 2026-10-19 revision

The AnimationState, physics mode, sequence, clipping and WebGPU additions were written from the public Spine 4.2 runtime documentation listed below, from general graphics mathematics and from the W3C WebGPU/WGSL specifications. As before, no official or derived runtime source, bundle, shader source or decompiled code was read, searched, copied or incorporated. The documentation describes concepts and API behaviour; the implementation and all test fixtures are original.

Documentation consulted (accessed 2026-10-19):

- https://esotericsoftware.com/spine-api-reference-4.2
- https://esotericsoftware.com/spine-applying-animations
- https://esotericsoftware.com/spine-unity-events
- https://esotericsoftware.com/spine-constraints
- https://esotericsoftware.com/spine-ik-constraints
- https://esotericsoftware.com/spine-transform-constraints
- https://esotericsoftware.com/spine-path-constraints
- https://esotericsoftware.com/spine-physics-constraints
- https://esotericsoftware.com/spine-clipping
- https://esotericsoftware.com/spine-regions
- https://esotericsoftware.com/spine-skins
- https://esotericsoftware.com/spine-binary-format
- https://esotericsoftware.com/spine-json-format
- https://esotericsoftware.com/spine-changelog
- https://esotericsoftware.com/spine-unity-rendering
- https://www.w3.org/TR/webgpu/
- https://www.w3.org/TR/WGSL/

Generated game metadata (per-skeleton mix tables) and the site adapter are kept out of this repository.
