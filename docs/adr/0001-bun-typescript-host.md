---
status: accepted
date: 2026-09-07
---

# Bun and TypeScript for the host

Pendia exists to be faster than Jellyfin, so a reader will expect Rust. We chose Bun and TypeScript. ffmpeg and libvips do the CPU work whichever language wraps them, so the host language decides development speed and startup time, not playback speed. Bun is the stack Mia already runs, trusted plugins load as lazy ES modules with no bridge, and a scope of eight mediums would take a multiple of the time in Rust.

## Considered options

- Rust: fastest and smallest, but every plugin call crosses an embedded V8 or Wasm boundary, and the build time of the full scope is prohibitive.
- Elixir: good process supervision, but no in-process JavaScript runtime and no JIT for Lua.
- Go: credible, but its JavaScript options are interpreters or cgo-bound V8.

## Consequences

A hot path that measures slow moves to Rust behind bun:ffi. The perf prototype on the map exists to catch that early.
