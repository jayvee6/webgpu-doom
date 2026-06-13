# webgpu-doom

A from-scratch **WebGPU renderer for [Freedoom](https://freedoom.github.io/)** — parse the IWAD
ourselves, build real 3D triangle geometry from the Doom map data, and render it with raw WGSL
pipelines. No Three.js, no WASM Doom port. The point is to own the engine.

Full design doc lives in the joeOS vault: `Projects/webgpu-doom.md`.

## Quick start

```bash
npm install
npm run fetch-wad   # downloads freedoom1/2.wad into public/ (gitignored)
npm run dev         # http://localhost:5173
```

WebGPU requires Chrome/Edge 113+, Safari 18+, or Firefox with WebGPU enabled.

## Status

- **M0 — done:** Vite + TS scaffold, WebGPU device up, canvas clears, debug surface on `window.__doom`.
- **M1 — next:** WAD parser (lump directory + E1M1 map lumps + PLAYPAL).
- M2 2D wireframe → M3 3D walls+floors → M4 textures → M5 sprites → M6 movement.

## Assets

Freedoom WADs are **not committed** (`.gitignore`d). `npm run fetch-wad` pulls a release zip and
extracts `freedoom1.wad` + `freedoom2.wad` into `public/`. Freedoom is BSD-licensed and freely
redistributable; we just keep the repo asset-clean.
