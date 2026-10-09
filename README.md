# sts-skeleton-player

Original browser skeletal-animation player for the publicly documented Spine 4.2 binary skeleton and atlas formats. Written independently using format documentation, mathematics and public-API black-box observations. See [cleanroom_log.md](cleanroom_log.md).

Regions, weighted/linked meshes, deform, skins, sequences, five bone inheritance modes, bone/slot timelines, IK, transform/path/physics constraints, events, draw order, track-zero crossfades and queued animation are implemented. WebGL supports clipping, tint/dark tint, four blend modes and straight or premultiplied alpha. Canvas2D is an approximate fallback. JSON skeletons, arbitrary multitrack layering and unused variants are unverified.

The final source-matched black-box matrix passes 1,810/1,810 eligible canonical cases across 853,822 compared frames. It covers 177 served skeleton paths, every skin and animation in the eligible corpus, both facing directions, replay mixing/crossfades, events, public bone/slot/vertex outputs, and fixed 512x512 rendered buffers. Three malformed original exports that the official player also cannot play are excluded as broken inputs; nothing playable by the official player is excluded.

Compatibility is proven for the exact installed Spine 4.2 export family observed in the shipping game and mods, including versions 4.2.03 through 4.2.43 and the features listed above. Unknown/newer binary layouts and unknown attachment types fail closed with an explicit reason. JSON skeleton inspection is supported, while JSON playback conversion remains unsupported and is reported as such. Canvas2D remains an approximate fallback.

Tests: `node --test skelplayer_test.cjs`. All fixtures are authored synthetic data. The published repository contains no game assets, extracted data, screenshots, third-party runtime files, parity receipts, or site history.

Copyright (c) 2026 moooohung. All rights reserved. No permission to use, copy, modify or redistribute is granted except by prior written permission. Source visibility grants no license. See [LICENSE](LICENSE).
