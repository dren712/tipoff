# Scene Assets & Credits

All 3D environment geometry, textures, normal maps, shaders, and jumbotron/vault graphics added in `app/src/Scene3D.ts` are procedurally generated at runtime (Canvas 2D & WebGL shaders) with zero external binary files added:

- **Procedural brushed-metal normal map** (`createBrushedNormalMap`, canvas noise, 256×256) — Source: procedural in `app/src/Scene3D.ts` — Licence: CC0 1.0 Universal
- **Procedural vertical gradient sky dome** (`ShaderMaterial`) — Source: procedural in `app/src/Scene3D.ts` — Licence: CC0 1.0 Universal
- **Procedural gate chevron flow texture & vault padlock emblem** (`CanvasTexture`) — Source: procedural in `app/src/Scene3D.ts` — Licence: CC0 1.0 Universal
- **Procedural arena tiers, instanced audience terminals, truss ring, moving-head beams, beveled Fresnel lane tiles, and jumbotron ticker** — Source: procedural `THREE` geometry/shaders in `app/src/Scene3D.ts` — Licence: CC0 1.0 Universal

Total added external asset size: **0 KB** (budget: < 1.5 MB).
