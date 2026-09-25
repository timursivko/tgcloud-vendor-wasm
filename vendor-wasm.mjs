// vendor-wasm — pack a WASM library into deployable lib/<name>/ modules.
//
// Usage:
//   node tools/vendor-wasm.mjs --from some-wasm-package [--out lib]
//   node tools/vendor-wasm.mjs --name mylib --wasm mod.wasm --loader glue.mjs \
//     --extra core.mjs:core.js --extra ffi.mjs:ffiWasm.js \
//     --map "@pkg/types:lib/mylib/ffi" [--out lib] [--split 80000] [--mode emscripten|raw]
//
// Rules enforced for the Telegram Serverless V8 isolate:
//  - only .js deploys -> .wasm ships as base64 chunks + aggregator
//  - static imports only (dynamic import() is rejected) -> bare/relative imports rewritten
//  - no URL/atob/setTimeout/performance in isolate -> sync instantiateWasm hook is generated
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const read = (p, enc) => fs.readFileSync(p, enc);
const stripMap = (s) => s.replace(/\/\/# sourceMappingURL=.*$/m, '');
const noExt = (f) => f.replace(/\.m?js$/, '');
const warnings = [];
const warn = (m) => { warnings.push(m); console.warn('warn: ' + m); };

function usage(err) {
  if (err) console.error('error: ' + err);
  console.log(`usage: node tools/vendor-wasm.mjs --preset <name|path> [--out lib]
       node tools/vendor-wasm.mjs --from <pkg> [--from <pkg2>] [--name <n>] [--out lib]
       node tools/vendor-wasm.mjs --name <n> --wasm <f.wasm> [--loader <glue.mjs>]
       [--extra <src[:dest]> ...] [--map <from:to> ...] [--out lib] [--split 80000] [--mode emscripten|raw] [--modules dir]`);
  process.exit(err ? 1 : 0);
}

const argv = process.argv.slice(2);
const opt = { extra: [], map: [], from: [], out: 'lib', split: 80000, mode: 'emscripten', modules: 'node_modules' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--extra' || a === '--map' || a === '--from') opt[a.slice(2)].push(argv[++i] ?? usage('missing value for ' + a));
  else if (a.startsWith('--')) opt[a.slice(2)] = argv[++i] ?? usage('missing value for ' + a);
  else usage('unknown arg ' + a);
}

// Glob helper: resolve hashed build internals (e.g. quickjs chunk-*.mjs) in --wasm/--loader.
// Presets are data (tools/presets/<name>.json or a path), not code:
// { name, wasm, loader, extra[], map[] } with paths relative to --modules
// and {name} placeholder expanded to --name.
function applyPreset(ref) {
  const file = ref.endsWith('.json') || ref.includes('/') || ref.includes('\\')
    ? ref
    : path.join(path.dirname(process.argv[1]), 'presets', `${ref}.json`);
  let p;
  try {
    p = JSON.parse(read(file, 'utf8'));
  } catch {
    usage(`--preset not found: ${file}`);
  }
  const fill = (v) => typeof v === 'string' ? v.replaceAll('{name}', opt.name ?? p.name ?? 'mylib') : v;
  opt.name ??= p.name;
  if (p.wasm && !opt.wasm) opt.wasm = path.join(opt.modules, p.wasm);
  if (p.loader && !opt.loader) opt.loader = path.join(opt.modules, p.loader);
  for (const e of [...(p.extra || [])].reverse()) {
    const i = e.lastIndexOf(':');
    const src = i >= 0 ? e.slice(0, i) : e;
    const dest = i >= 0 ? e.slice(i + 1) : null;
    opt.extra.unshift(dest ? `${path.join(opt.modules, src)}:${fill(dest)}` : path.join(opt.modules, src));
  }
  for (const x of [...(p.map || [])].reverse()) opt.map.unshift(fill(x));
}
function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function globOne(pattern, label) {
  if (!pattern.includes('*')) return pattern;
  const dir = path.dirname(pattern);
  const rx = new RegExp('^' + path.basename(pattern).split('*').map(escapeRx).join('.*') + '$');
  const hits = fs.readdirSync(dir).filter((f) => rx.test(f)).map((f) => path.join(dir, f));
  if (hits.length !== 1) usage(`${label}: glob '${pattern}' matched ${hits.length} files (need exactly 1)`);
  return hits[0];
}
function stripStrings(s) {
  return s.replace(/(['"`])(?:\\.|(?!\1).)*\1/gs, '""');
}
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\:"'])\/\/[^\n]*/g, '$1');
}
function codeSansNoise(s) {
  return stripComments(stripStrings(s));
}
// Split source into code vs strings/comments; callback fires only for real
// `from '...'` in code (rewriting inside strings would corrupt runtime text).
const TOKEN_RX = /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|from\s*['"][^'"]+['"])/g;
function eachImport(src, cb) {
  return src.replace(TOKEN_RX, (m) => {
    const im = m.match(/^from\s*['"]([^'"]+)['"]$/);
    return im ? cb(im[1], m) : m;
  });
}
function walkFiles(root, out = [], depth = 0) {
  if (depth > 5) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) walkFiles(p, out, depth + 1);
    else if (e.isFile()) out.push(p);
  }
  return out;
}
function scoreGlue(file, src) {
  let s = 0;
  const why = [];
  const base = path.basename(file);
  if (/(module|loader|glue|esm|browser|wrapper|factory)/i.test(base)) { s += 2; why.push('name'); }
  if (/worker/i.test(base)) { s -= 2; why.push('no-Worker-in-isolate'); }
  if (/(^|[-_.])(node|cjs|umd)([-_.]|$)/i.test(base)) { s -= 3; why.push('node-ish'); }
  if (/(test|spec|example|demo|bench)/i.test(base)) { s -= 3; why.push('test-like'); }
  const code = stripStrings(src);
  if (/\bmodule\.exports\b|\bexports\.\w+\s*=/.test(code)) { s -= 5; why.push('cjs'); }
  if (/wasmBinary/.test(src)) { s += 2; why.push('wasmBinary'); }
  if (/instantiateWasm|instantiateStreaming/.test(src)) { s += 1; why.push('instantiate'); }
  if (/WebAssembly\s*\./.test(src)) { s += 2; why.push('WebAssembly'); }
  if (/export\s+default/.test(src)) { s += 1; why.push('default-export'); }
  return { score: s, why };
}
function resolveBare(spec) {
  const segs = spec.split('/');
  const pkgName = spec.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
  const sub = spec.startsWith('@') ? segs.slice(2).join('/') : segs.slice(1).join('/');
  const pkgDir = path.join(opt.modules, pkgName);
  let pj;
  try {
    pj = JSON.parse(read(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const pick = (exp) => {
    if (typeof exp === 'string') return exp;
    if (exp && typeof exp === 'object') {
      if (sub) {
        const v = exp['./' + sub] ?? exp[sub];
        if (v) return pick(v);
      } else {
        for (const c of ['browser', 'worker', 'import', 'default']) {
          if (typeof exp[c] === 'string') return exp[c];
        }
        if (exp['.']) return pick(exp['.']);
      }
    }
    return null;
  };
  const rel = (pj.exports ? pick(pj.exports) : null) || pj.module || pj.main || null;
  if (!rel) return null;
  const abs = path.join(pkgDir, rel);
  return fs.existsSync(abs) ? abs : null;
}
function resolveRelative(dir, spec) {
  const base = path.resolve(dir, spec);
  for (const c of [base, base + '.mjs', base + '.js', path.join(base, 'index.mjs'), path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}
function sanitizeDest(s) {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}
const A = (p) => path.resolve(p); // absolute, for reliable identity
function show(p) {
  const r = path.relative(process.cwd(), p);
  return r.startsWith('..') || path.isAbsolute(r) ? p : r;
}
// Split "src[:dest]": the dest separator is the last colon that leaves an
// existing file on the left (so Windows drive letters like C:\... survive).
function splitExtra(e) {
  const i = e.lastIndexOf(':');
  if (i >= 0) {
    const src = e.slice(0, i);
    if (!src.includes('*') && fs.existsSync(src)) return [src, e.slice(i + 1) || path.basename(src), true];
  }
  return [e, path.basename(e), false];
}
// Expand a possible glob into [{src, dest}]. Dest (after last colon) requires
// exactly one hit; without dest every hit is vendored under its own basename.
function expandExtra(e) {
  let src = e;
  let dest = null;
  const i = e.lastIndexOf(':');
  if (i >= 0 && !e.slice(0, i).includes('*') && fs.existsSync(e.slice(0, i))) {
    src = e.slice(0, i);
    dest = e.slice(i + 1) || path.basename(src);
  } else if (i >= 0) {
    const tail = e.slice(i + 1);
    if (tail && !tail.includes('*') && !tail.includes('/') && !tail.includes(path.sep)) {
      src = e.slice(0, i);
      dest = tail;
    }
  }
  if (!src.includes('*')) {
    if (!fs.existsSync(src)) usage(`--extra file not found: ${src}`);
    return [{ src, dest: dest || path.basename(src) }];
  }
  const dir = path.dirname(src);
  const rx = new RegExp('^' + path.basename(src).split('*').map(escapeRx).join('.*') + '$');
  const hits = fs.readdirSync(dir).filter((f) => rx.test(f)).map((f) => path.join(dir, f));
  if (!hits.length) usage(`--extra glob matched nothing: ${src}`);
  if (hits.length > 1 && dest) {
    const specsOf = (h) => {
      const out = [];
      eachImport(read(h, 'utf8'), (spec) => { out.push(spec); });
      return out;
    };
    const selfContained = hits.filter((h) => !specsOf(h).some((s) => s.startsWith('.')));
    if (selfContained.length === 1) {
      warn(`--extra glob matched ${hits.length} files, picked self-contained ${path.basename(selfContained[0])}`);
      return [{ src: selfContained[0], dest }];
    }
    usage(`--extra glob matched ${hits.length} files but dest is single: ${src} (add :dest per file or narrow the pattern)`);
  }
  return hits.map((h) => ({ src: h, dest: dest || path.basename(h) }));
}
// --from: discover wasm + glue + deps inside installed packages.
function discoverPackages() {
  const jsFiles = [];
  const wasms = [];
  for (const p of opt.from) {
    const root = path.join(opt.modules, p);
    if (!fs.existsSync(root)) usage(`--from: package not found: ${root}`);
    for (const f of walkFiles(root)) {
      if (/\.wasm$/i.test(f)) wasms.push(f);
      else if (/\.(mjs|js)$/i.test(f) && !/\.map$/i.test(f) && !/\.d\.[mc]?ts$/i.test(f) && fs.statSync(f).size < 4 * 1024 * 1024) jsFiles.push(f);
    }
  }
  if (!opt.name) {
    opt.name = opt.from[0].split('/').pop().replace(/[^A-Za-z0-9_-]+/g, '-');
    console.log(`discovered name: ${opt.name}`);
  }
  if (!opt.wasm) {
    if (wasms.length !== 1) {
      console.error(`--from: found ${wasms.length} .wasm files:`);
      wasms.forEach((w) => console.error('  ' + w));
      usage(wasms.length ? 'pass exactly one via --wasm' : 'no .wasm found — is the binary in a different package?');
    }
    opt.wasm = wasms[0];
    console.log(`discovered wasm: ${show(opt.wasm)}`);
  }
  const scored = jsFiles.map((f) => ({ f, ...scoreGlue(f, read(f, 'utf8')), dots: path.basename(f).split('.').length }))
    .sort((a, b) => b.score - a.score || a.dots - b.dots || (a.f < b.f ? -1 : 1));
  if (!opt.loader) {
    const top = scored[0];
    if (!top || top.score < 2) {
      console.error('--from: no convincing glue file. top candidates:');
      scored.slice(0, 5).forEach((c) => console.error(`  [${c.score}] ${c.f} (${c.why.join(', ')})`));
      usage('pick one explicitly via --loader');
    }
    opt.loader = top.f;
    console.log(`discovered loader: ${show(opt.loader)} (score ${top.score}: ${top.why.join(', ')})`);
  }
  // package entries + transitive relative closure (loader, explicit extras, entries)
  const entryDest = new Map(); // abs -> dest for package entries
  const queue = [opt.loader];
  for (const e of opt.extra) queue.push(splitExtra(e)[0]);
  for (const p of opt.from) {
    const entry = resolveBare(p);
    if (entry && /\.(mjs|js)$/i.test(entry)) {
      const dest = `entry-${sanitizeDest(p.split('/').pop())}.js`;
      entryDest.set(A(entry), dest);
      queue.push(entry);
      console.log(`discovered entry: ${show(entry)} (as ${dest})`);
    }
  }
  const seenAbs = new Set();
  while (queue.length) {
    const abs = A(queue.pop());
    if (seenAbs.has(abs) || !fs.existsSync(abs)) continue;
    seenAbs.add(abs);
    let src;
    try {
      src = read(abs, 'utf8');
    } catch {
      continue;
    }
    eachImport(src, (spec) => {
      if (!spec.startsWith('.')) return;
      const r = resolveRelative(path.dirname(abs), spec);
      if (r && /\.(mjs|js)$/i.test(r)) queue.push(r);
    });
  }
  const loaderAbs = A(opt.loader);
  const RESERVED = new Set(['loader.js', 'wasm.js', 'index.js']);
  const normDest = (d) => d.replace(/\.mjs$/i, '.js');
  for (const abs of seenAbs) {
    if (abs === loaderAbs) continue;
    const already = opt.extra.some((e) => A(splitExtra(e)[0]) === abs);
    if (!already) {
      let dest = sanitizeDest(path.basename(abs));
      if (entryDest.has(abs)) dest = entryDest.get(abs);
      else if (RESERVED.has(normDest(dest)) || /^wasmP\d+\.js$/.test(normDest(dest))) dest = 'dep-' + dest;
      dest = normDest(dest);
      opt.extra.push(`${abs}:${dest}`);
      console.log(`discovered extra: ${show(abs)} (as ${dest})`);
    }
  }
  // bare imports: auto-vendor clean ESM deps, warn on the rest
  const bare = new Set();
  const collectBare = (abs) => {
    if (!fs.existsSync(abs)) return;
    eachImport(read(abs, 'utf8'), (spec) => {
      if (spec.startsWith('.')) return;
      if (!spec.startsWith('lib/') && spec !== 'sdk' && !spec.startsWith('sdk/')) bare.add(spec);
    });
  };
  for (const e of opt.extra) collectBare(splitExtra(e)[0]);
  try {
    collectBare(opt.loader);
  } catch {}
  for (const spec of bare) {
    if (opt.map.some((x) => x.split(/:(.+)/)[0] === spec)) continue;
    const abs = resolveBare(spec);
    if (!abs) {
      warn(`bare import '${spec}' could not be auto-resolved — vendor it via --extra/--map`);
      continue;
    }
    const code = codeSansNoise(read(abs, 'utf8'));
    if (/\bmodule\.exports\b|\bexports\.\w+\s*=/.test(code)) {
      warn(`bare import '${spec}' resolves to CommonJS (${show(abs)}) — vendor an ESM build via --extra/--map`);
      continue;
    }
    const sched = opt.extra.map((e) => splitExtra(e)).find(([s]) => A(s) === A(abs));
    if (sched) {
      opt.map.push(`${spec}:lib/${opt.name}/${noExt(sched[1])}`);
      console.log(`discovered dep: '${spec}' -> already scheduled as ${sched[1]}`);
      continue;
    }
    const dest = sanitizeDest(spec.replace(/[@/]/g, '_') + '_' + path.basename(abs));
    opt.extra.push(`${abs}:${dest}`);
    opt.map.push(`${spec}:lib/${opt.name}/${noExt(dest)}`);
    console.log(`discovered dep: '${spec}' -> ${show(abs)} (as ${dest})`);
  }
  // suggestions: other ESM files shipped but not pulled in
  const included = new Set([loaderAbs, ...seenAbs]);
  const rest = scored.filter((c) => !included.has(A(c.f)) && c.score >= 0).slice(0, 5);
  if (rest.length) {
    console.log('also shipped (add via --extra if your wiring needs them):');
    rest.forEach((c) => console.log(`  [${c.score}] ${c.f}`));
  }
  console.log('equivalent manual command:');
  console.log(`  node tools/vendor-wasm.mjs --name ${opt.name} --wasm ${show(opt.wasm)} --loader ${show(opt.loader)}` +
    opt.extra.map((e) => {
      const [s, d] = splitExtra(e);
      return ` --extra ${show(s)}${d !== path.basename(s) ? ':' + d : ''}`;
    }).join('') + opt.map.map((x) => ` --map "${x}"`).join(''));
}
if (opt.preset) applyPreset(opt.preset);
if (opt.from.length) discoverPackages();
opt.wasm = opt.wasm && globOne(opt.wasm, '--wasm');
opt.loader = opt.loader && globOne(opt.loader, '--loader');
if (!opt.name) usage('--name required');
if (!opt.wasm) usage('--wasm required');
if (!/^[A-Za-z0-9_-]+$/.test(opt.name)) usage('bad --name (letters/digits/_/-)');
opt.split = Number(opt.split) || 80000;
if (!['emscripten', 'raw'].includes(opt.mode)) usage('--mode must be emscripten|raw');
if (opt.mode === 'emscripten' && !opt.loader) usage('--loader required in emscripten mode');

// Rewrite import specifiers: relative -> lib/<name>/basename, mapped bare -> mapping.
function rewriteImports(src, srcDir) {
  return eachImport(src, (spec, m) => {
    if (spec === 'sdk' || spec.startsWith('sdk/') || spec.startsWith('lib/')) return m;
    const mapped = opt.map.map((x) => x.split(/:(.+)/).slice(0, 2)).find(([f]) => f === spec);
    if (mapped) return m.replace(spec, mapped[1]);
    if (spec.startsWith('.')) {
      const r = resolveRelative(srcDir, spec);
      if (r && destByAbs.has(path.normalize(r))) {
        return m.replace(spec, `lib/${opt.name}/${noExt(destByAbs.get(path.normalize(r)))}`);
      }
      const base = noExt(path.basename(spec));
      warn(`relative import '${spec}' -> 'lib/${opt.name}/${base}' (verify)`);
      return m.replace(spec, `lib/${opt.name}/${base}`);
    }
    warn(`bare import '${spec}' left as-is (not deployable unless lib//sdk/)`);
    return m;
  });
}

function checkESM(src, label) {
  const code = codeSansNoise(src);
  if (/\bmodule\.exports\b|\bexports\.\w+\s*=/.test(code)) {
    console.error(`error: ${label} looks like CommonJS (module.exports) — only ESM is deployable`);
    process.exit(1);
  }
  if (/\brequire\s*\(/.test(code))
    warn(`${label} contains require() — ok only if guarded by a node-only branch (never executed in isolate)`);
  if (/\bimport\s*\(/.test(code)) warn(`${label} uses dynamic import() — rejected in isolate, refactor to static`);
}

const dir = path.join(opt.out, opt.name);
fs.mkdirSync(dir, { recursive: true });
const made = [];
function writeOut(name, content) {
  fs.writeFileSync(path.join(dir, name), content);
  made.push(name);
}

// 1. extra ESM files (explicit + discovered), dest-aware import rewrite
const destByAbs = new Map();
const jobs = [];
for (const e of opt.extra) {
  for (const { src, dest: d0 } of expandExtra(e)) {
    const abs = A(src);
    if (destByAbs.has(abs)) continue; // same file scheduled twice (entry + dep)
    let dest = d0.replace(/\.mjs$/i, '.js'); // platform deploys .js only
    const taken = new Set(jobs.map((j) => j.dest));
    if (taken.has(dest) || ['loader.js', 'wasm.js', 'index.js'].includes(dest) || /^wasmP\d+\.js$/.test(dest)) {
      dest = sanitizeDest(path.basename(path.dirname(abs)) + '_' + path.basename(abs));
      if (taken.has(dest)) usage(`dest collision for ${abs}`);
      warn(`dest collision, vendored as ${dest}`);
    }
    destByAbs.set(abs, dest);
    jobs.push({ abs, dest });
  }
}
for (const { abs, dest } of jobs) {
  let s = stripMap(read(abs, 'utf8'));
  checkESM(s, abs);
  writeOut(dest, rewriteImports(s, path.dirname(abs)));
}

// 2. loader (emscripten factory)
if (opt.loader) {
  let s = stripMap(read(opt.loader, 'utf8'));
  checkESM(s, opt.loader);
  if (/\.wasm['"]/.test(s)) warn('loader references a .wasm path — runtime must use embedded wasmBinary instead');
  writeOut('loader.js', rewriteImports(s, path.dirname(opt.loader)));
}

// 3. wasm -> base64 parts + aggregator
const wasm = read(opt.wasm);
const b64 = wasm.toString('base64');
const per = opt.split;
const parts = [];
for (let i = 0, n = 1; i < b64.length; i += per, n++) {
  writeOut(`wasmP${n}.js`, `export default "${b64.slice(i, i + per)}";\n`);
  parts.push(n);
}
writeOut('wasm.js', parts.map((n) => `import p${n} from 'lib/${opt.name}/wasmP${n}';`).join('\n') +
  `\n\nexport default ${parts.map((n) => `p${n}`).join(' + ')};\n`);

// 4. entry with sync instantiate hook (emscripten mode)
if (opt.mode === 'emscripten') {
  writeOut('index.js',
`import factory from 'lib/${opt.name}/loader';
import wasmB64 from 'lib/${opt.name}/wasm';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function b64ToBytes(s) {
  const out = [];
  let acc = 0, bits = 0;
  for (const ch of s) {
    if (ch === '=') break;
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); acc &= (1 << bits) - 1; }
  }
  return new Uint8Array(out);
}

let p = null;
// NOTE: the isolate has no URL/atob/setTimeout and async WebAssembly.instantiate hangs,
// so: embedded wasmBinary + dummy locateFile + fully synchronous instantiateWasm hook.
export function getModule() {
  if (!p) {
    p = (async () => {
      const wasmBinary = b64ToBytes(wasmB64);
      return factory({
        wasmBinary,
        locateFile: () => 'module.wasm',
        instantiateWasm: (imports, onSuccess) => {
          const module = new WebAssembly.Module(wasmBinary);
          onSuccess(new WebAssembly.Instance(module, imports), module);
          return {};
        },
      });
    })();
  }
  return p;
}
`);
} else {
  // raw mode: report what the module imports so a stub can be written
  const mod = new WebAssembly.Module(wasm);
  console.log('wasm imports:');
  for (const i of WebAssembly.Module.imports(mod)) console.log(`  ${i.module}.${i.name} (${i.kind})`);
  console.log(`wasm exports: ${WebAssembly.Module.exports(mod).length}, size: ${wasm.length} bytes`);
}

// 5. verify: syntax-check as ESM (via .mjs temp copies) + base64 roundtrip
const tmpCheck = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-wasm-'));
try {
  for (const f of made) {
    const tmp = path.join(tmpCheck, f.replace(/\.js$/, '.mjs'));
    fs.copyFileSync(path.join(dir, f), tmp);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  }
} finally {
  fs.rmSync(tmpCheck, { recursive: true, force: true });
}
const joined = parts.map((n) => fs.readFileSync(path.join(dir, `wasmP${n}.js`), 'utf8').match(/"([A-Za-z0-9+/=]*)"/)[1]).join('');
if (joined !== b64) { console.error('error: base64 roundtrip mismatch'); process.exit(1); }
console.log(`ok: ${path.join(opt.out, opt.name)}/ (${made.length} files, wasm ${wasm.length} bytes -> base64 ${b64.length} chars)`);
if (warnings.length) console.log(`${warnings.length} warning(s) — review above`);
console.log('isolate notes: static imports only; no URL/atob/setTimeout/performance/import(); keep heap modest');
