# vendor-wasm

Pack a WebAssembly library into deployable modules for [Telegram Serverless](https://core.telegram.org/bots/serverless)
(V8 isolate: no npm, no filesystem, static imports only).

## Why

The platform deploys **only `.js` files** (`schema.js`, `lib/`, `handlers/`) — verified:
a real `.wasm` placed in `lib/` is invisible to `tgcloud status`. And at runtime there is
no filesystem to read it from anyway. This tool embeds the binary as base64 chunks inside
`.js` modules and generates the wiring that the isolate actually supports:

- embedded `wasmBinary` (no fetch of a `.wasm` URL — and `URL` doesn't exist there anyway)
- fully **synchronous** instantiation (`new WebAssembly.Module` + `new WebAssembly.Instance`),
  because async `WebAssembly.instantiate` never resolves in the isolate (hangs ~32s)
- no `atob`/`Buffer` (a dependency-free base64 decoder is generated)
- static `import`s only (`import()` throws `Not supported`)

## Requirements

Node.js 18+.

## Install

```bash
npm i -g tgcloud-vendor-wasm
```

## Quick start

```bash
npm i @sqlite.org/sqlite-wasm
vendor-wasm --from @sqlite.org/sqlite-wasm --out lib
```

Finds the `.wasm`, scores glue candidates, pulls relative deps transitively (including
package entries), auto-vendors clean ESM bare imports, prints the equivalent manual
command. Cross-package API layers still need a hand — see [Limitations](#limitations).

Manual mode (`*` globs allowed in paths — handy for hashed build files like `chunk-*.mjs`):

```bash
vendor-wasm --name mylib --wasm mod.wasm --loader glue.mjs \
  --extra api.mjs:api.js \
  --map "@pkg/types:lib/mylib/ffi" \
  [--out lib] [--split 80000] [--mode emscripten|raw] [--modules node_modules]
```

| Flag | Meaning |
| ---- | ------- |
| `--from pkg` | Auto-discover inside installed package (repeatable) |
| `--name` | Target folder: `lib/<name>/` (required unless discovered) |
| `--wasm` | The `.wasm` binary → `wasmP1..N.js` + `wasm.js` aggregator (required) |
| `--loader` | ESM glue factory (Emscripten `MODULARIZE`) → `loader.js` (required in `emscripten` mode) |
| `--extra src[:dest]` | Extra ESM files, imports rewritten (repeatable) |
| `--map from:to` | Rewrite a bare import specifier (repeatable) |
| `--out` | Output root (default `lib`) |
| `--split` | Base64 chars per chunk (default `80000`) |
| `--mode` | `emscripten` (default) or `raw` (prints the module's imports so you can write stubs) |
| `--modules` | node_modules root (default `node_modules`) |

The tool aborts on CommonJS, on zero/ambiguous `.wasm` or glue matches (it lists candidates
instead of guessing), warns on `require()` / dynamic `import()` / `.wasm` path references,
syntax-checks every generated file and verifies the base64 roundtrip.

## How discovery scores glue

Content + filename heuristics: `wasmBinary` / `WebAssembly.*` / `instantiate*` /
default export / `module|loader|glue|esm|browser|wrapper|factory` score up; CJS markers,
`node`-ish names, `worker` (no `Worker` in the isolate), test/example files score down.
Ties break toward the plainer filename. Run with `--loader` to override the pick.

## Using the output (emscripten mode)

```js
import { getModule } from 'lib/mylib';

const M = await getModule(); // singleton, sync-instantiated module
```

Isolate notes: static imports only; no `URL`, `atob`, `setTimeout`, `performance`,
`import()`; give the guest a compute budget (interrupt handler) and a memory limit
(see `lib/code.js` in this repo for a complete example with QuickJS).

## Limitations

- API-layer files from *other* packages (like QuickJS's core chunk) are out of scope for
  discovery — the tool lists shipped-but-unincluded files so you can add them via `--extra`.
- Single-threaded, non-WASI builds only: no threads, no `wasi_snapshot_preview1` shims.
  Prefer `browser`/`worker`-flavored ESM glue over `node`/debug variants.
- Debug builds score high (they contain every marker) — override with `--loader` if you
  want the release file.

## Contributing presets

Got a library that needs hand-written flags? Send a PR adding `presets/<name>.json`:

```json
{
  "name": "qjs",
  "wasm": "@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
  "loader": "@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.mjs",
  "extra": [
    "quickjs-emscripten-core/dist/chunk-*.mjs:core.js",
    "@jitl/quickjs-ffi-types/dist/index.mjs:ffi.js",
    "@jitl/quickjs-wasmfile-release-sync/dist/ffi.mjs:ffiWasm.js"
  ],
  "map": ["@jitl/quickjs-ffi-types:lib/{name}/ffi"]
}
```

Paths are relative to `--modules`; `{name}` expands to `--name`; explicit flags win.
Use it via `--preset <name>` (or a direct JSON path). Please verify the output with the
tool's own checks plus a real `--from`/manual run before submitting.

## License

MIT — see [LICENSE](./LICENSE). Replace the copyright holder before publishing.
