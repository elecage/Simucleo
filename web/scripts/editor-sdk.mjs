// The in-browser C build (M33): pack what the editor and the compiler worker
// download into web/public/.
//
//   public/editor/hal-symbols.json     autocomplete index from the HAL/CMSIS/newlib
//                                      headers (always: the headers are vendored)
//   public/toolchain/                  only when firmware/editor-sdk is built and the
//                                      compiler package is installed:
//     clang.js                         the compiler package's loader (microbit-clang-wasm)
//     llvm.core*.wasm.gz.bin           clang + ld.lld as WebAssembly, gzip
//     clang-include.tar.gz.bin         clang's own headers for Arm (stdint.h, …)
//     sdk-hal.tar.gz.bin               HAL/CMSIS/newlib headers + the prebuilt libraries
//
// (".gz.bin", not ".gz": some servers send a .gz file with Content-Encoding:
// gzip, the browser unpacks it, and the bytes no longer match the service
// worker's integrity hash. Unpacked in JavaScript instead.)
//     manifest.json                    sizes and a version (cache name)
//     LICENSE*.txt / *.md              the package's licences
//
// The toolchain is not in the default offline cache (M29): the service
// worker lists it apart and caches it only on "편집기 오프라인으로 받기".
//
//   node scripts/editor-sdk.mjs          (part of `npm run build`)
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readTar, writeTar } from "../src/code/tar.ts";
import { buildIndex, packIndex } from "../src/code/symbols.ts";
import { SDK_LINK_FILES, TOOLCHAIN_ASSETS } from "../src/code/sdk.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const fw = join(web, "..", "firmware");
const vendor = join(fw, "vendor");
const sdkBuild = join(fw, "editor-sdk", "build");
const pkgDir = join(web, "node_modules", "microbit-clang-wasm");
const outDir = join(web, "public", "toolchain");
const editorDir = join(web, "public", "editor");
/** Build-time stamps (not shipped). */
const stampDir = join(web, "node_modules", ".cache", "simucleo-editor");

/** Every file under `dir` (relative paths with "/"), filtered. */
function walk(dir, keep = () => true, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep, base));
    else {
      const rel = relative(base, full).split(sep).join("/");
      if (keep(rel)) out.push(rel);
    }
  }
  return out;
}

// ------------------------------------------------------------ symbol index

/** HAL modules the prebuilt library has (firmware/editor-sdk/Makefile). */
const HAL_HEADERS = [
  "", "_def", "_cortex", "_rcc", "_rcc_ex", "_gpio", "_gpio_ex", "_pwr", "_pwr_ex", "_flash", "_flash_ex", "_uart",
  "_dma", "_dma_ex", "_exti", "_tim", "_tim_ex", "_adc", "_adc_ex", "_i2c", "_i2c_ex", "_spi",
].map((m) => `stm32f4xx_hal${m}`);
const LIBC_HEADERS = ["stdio.h", "string.h", "stdlib.h", "math.h", "stdint.h", "stdbool.h", "machine/_default_types.h"];

function symbolIndex() {
  const headers = [
    ...["main.h"].map((f) => ({ file: `hal-common/${f}`, path: join(fw, "hal-common", "Inc", f) })),
    ...HAL_HEADERS.map((m) => ({ file: `hal/${m}.h`, path: join(vendor, "stm32f4xx_hal_driver", "Inc", `${m}.h`) })),
    ...["stm32f401xe.h", "stm32f4xx.h", "system_stm32f4xx.h"].map((f) => ({ file: `device/${f}`, path: join(vendor, "cmsis_device_f4", "Include", f) })),
    ...["core_cm4.h", "cmsis_gcc.h"].map((f) => ({ file: `cmsis/${f}`, path: join(vendor, "CMSIS", "Include", f) })),
  ];
  const libc = join(sdkBuild, "include", "libc");
  if (existsSync(libc)) headers.push(...LIBC_HEADERS.map((f) => ({ file: `libc/${f}`, path: join(libc, f) })));
  const sources = HAL_HEADERS.filter((m) => !m.endsWith("_def"))
    .map((m) => join(vendor, "stm32f4xx_hal_driver", "Src", `${m}.c`))
    .filter(existsSync)
    .map((p) => ({ text: readFileSync(p, "utf8") }));
  const syms = buildIndex(
    headers.filter((h) => existsSync(h.path)).map((h) => ({ file: h.file, text: readFileSync(h.path, "latin1") })),
    sources,
    // The device header's bit positions and masks (RCC_AHB1ENR_GPIOAEN_Pos,
    // …_Msk): thousands nobody types; the bit names themselves stay.
  ).filter((s) => !(s.kind === "macro" && /_(Pos|Msk)$/.test(s.name)));
  mkdirSync(editorDir, { recursive: true });
  const json = JSON.stringify(packIndex(syms));
  writeFileSync(join(editorDir, "hal-symbols.json"), json + "\n");
  console.log(`hal-symbols.json: ${syms.length} symbols (${(json.length / 1024).toFixed(0)} KB, gzip ${(gzipSync(json).length / 1024).toFixed(0)} KB)`);
}

// ------------------------------------------------------------ toolchain

/** clang's own headers an Arm C build can use (not x86/PowerPC/GPU intrinsics). */
const CLANG_HEADER =
  /^lib\/clang\/\d+\/include\/(__stdarg_[\w]+\.h|__stddef_[\w]+\.h|std\w*\.h|float\.h|limits\.h|iso646\.h|varargs\.h|inttypes\.h|tgmath\.h|unwind\.h|arm_acle\.h|arm_cmse\.h|arm_fp16\.h|arm_bf16\.h|arm_vector_types\.h|ptrauth\.h|builtins\.h)$/;

const gz = (b) => gzipSync(b, { level: 9 });
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** Write `name` unless the same bytes are there (keeps mtimes for vite). */
function put(name, bytes) {
  const p = join(outDir, name);
  if (existsSync(p) && sha(readFileSync(p)) === sha(bytes)) return;
  writeFileSync(p, bytes);
}

function toolchain() {
  const gen = join(pkgDir, "gen");
  const missing = [
    !existsSync(join(gen, "bundle.js")) && "the compiler package (npm ci)",
    !SDK_LINK_FILES.every((f) => existsSync(join(sdkBuild, f))) && "firmware/editor-sdk (make -C firmware/editor-sdk)",
  ].filter(Boolean);
  if (missing.length) {
    console.warn(`toolchain: skipped, missing ${missing.join(" and ")} — the code tab will say the build is unavailable`);
    rmSync(outDir, { recursive: true, force: true });
    return;
  }
  mkdirSync(outDir, { recursive: true });
  // Files of an older layout would be shipped (and listed) too.
  for (const f of readdirSync(outDir)) if (f.endsWith(".gz")) rmSync(join(outDir, f));
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const files = {};

  // clang.js: the loader, unchanged (it asks for its assets by name; the worker supplies them).
  put("clang.js", readFileSync(join(gen, "bundle.js")));
  for (const name of TOOLCHAIN_ASSETS) {
    if (name === "llvm-resources.tar") continue;
    const src = join(gen, name);
    mkdirSync(stampDir, { recursive: true });
    const stamp = join(stampDir, `${name}.gz.src`);
    const key = `${statSync(src).size}:${statSync(src).mtimeMs}:${pkg.version}`;
    // Gzipping 60 MB at level 9 takes a while: only when the package changed.
    if (!existsSync(join(outDir, `${name}.gz.bin`)) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== key) {
      writeFileSync(join(outDir, `${name}.gz.bin`), gz(readFileSync(src)));
      writeFileSync(stamp, key);
    }
    files[name] = { url: `toolchain/${name}.gz.bin`, bytes: statSync(join(outDir, `${name}.gz.bin`)).size, gzip: true };
  }
  // In place of the package's 35 MB resource tar (sysroot for another board,
  // C++ headers): only clang's builtin headers for Arm.
  const resources = readTar(new Uint8Array(readFileSync(join(gen, "llvm-resources.tar"))));
  const headers = resources.filter((e) => CLANG_HEADER.test(e.name));
  if (!headers.some((e) => e.name.endsWith("/stdint.h"))) throw new Error("toolchain: no clang stdint.h in the package");
  put("clang-include.tar.gz.bin", gz(writeTar(headers)));
  files["llvm-resources.tar"] = { url: "toolchain/clang-include.tar.gz.bin", bytes: statSync(join(outDir, "clang-include.tar.gz.bin")).size, gzip: true };

  // The SDK bundle.
  const entries = [];
  const add = (dir, prefix, keep) => {
    for (const rel of walk(dir, keep)) entries.push({ name: `sdk/${prefix}/${rel}`, data: new Uint8Array(readFileSync(join(dir, rel))) });
  };
  const header = (r) => r.endsWith(".h");
  add(join(fw, "hal-common", "Inc"), "include/hal-common", header);
  add(join(vendor, "stm32f4xx_hal_driver", "Inc"), "include/hal", header);
  add(join(vendor, "cmsis_device_f4", "Include"), "include/device", header);
  add(join(vendor, "CMSIS", "Include"), "include/cmsis", header);
  add(join(sdkBuild, "include", "libc"), "include/libc", header);
  add(join(sdkBuild, "lib"), "lib", () => true);
  for (const [from, to] of [
    [join(vendor, "stm32f4xx_hal_driver", "LICENSE.md"), "licenses/stm32f4xx_hal_driver.md"],
    [join(vendor, "cmsis_device_f4", "LICENSE.md"), "licenses/cmsis_device_f4.md"],
    [join(vendor, "CMSIS", "LICENSE.txt"), "licenses/CMSIS.txt"],
    ["/usr/share/doc/libnewlib-arm-none-eabi/copyright", "licenses/newlib.txt"],
    ["/usr/share/doc/gcc-arm-none-eabi/copyright", "licenses/libgcc.txt"],
  ]) {
    if (existsSync(from)) entries.push({ name: `sdk/${to}`, data: new Uint8Array(readFileSync(from)) });
  }
  const sdkTar = gz(writeTar(entries));
  put("sdk-hal.tar.gz.bin", sdkTar);

  for (const lic of ["LICENSE.txt", "LICENSES.md"]) if (existsSync(join(pkgDir, lic))) copyFileSync(join(pkgDir, lic), join(outDir, `clang-${lic}`));

  const version = sha(
    Object.values(files)
      .map((f) => sha(readFileSync(join(web, "public", f.url))))
      .concat(sha(sdkTar), sha(readFileSync(join(outDir, "clang.js"))))
      .join("\n"),
  ).slice(0, 12);
  const manifest = { version, llvm: `${pkg.name}@${pkg.version} (LLVM ${pkg.llvm?.version ?? "?"})`, files, sdk: { url: "toolchain/sdk-hal.tar.gz.bin", bytes: sdkTar.length } };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const total = Object.values(files).reduce((s, f) => s + f.bytes, 0) + sdkTar.length + statSync(join(outDir, "clang.js")).size;
  console.log(`toolchain: ${manifest.llvm}, ${(total / 1048576).toFixed(1)} MB to download (SDK ${(sdkTar.length / 1024).toFixed(0)} KB), version ${version}`);
}

symbolIndex();
toolchain();
