// The project template the in-browser build uses (M33): where the SDK bundle
// (web/public/toolchain/sdk-hal.tar.gz, made by scripts/editor-sdk.mjs from
// firmware/editor-sdk) puts its headers and prebuilt libraries in the
// compiler's file system, and the clang/ld.lld command lines. Shared by the
// compiler worker, the packaging script and the Node integration test.

/** Where the SDK bundle is unpacked in the compiler's virtual file system. */
export const SDK_ROOT = "/sdk";
/** Where the student's files go: `/project/Core/Src/main.c`. */
export const PROJECT_ROOT = "/project";
const OUT = "/build";

/** Include directories inside the SDK bundle, in search order. */
export const SDK_INCLUDES = ["include/hal-common", "include/hal", "include/device", "include/cmsis"];
/** newlib's headers: a system directory (after the project's own). */
export const SDK_LIBC = "include/libc";

export const ARCH_FLAGS = [
  "--target=thumbv7em-none-eabihf",
  "-mcpu=cortex-m4",
  "-mthumb",
  "-mfpu=fpv4-sp-d16",
  "-mfloat-abi=hard",
];

/** clang flags for a student's .c file. */
export function compileFlags(projectIncludes: string[]): string[] {
  return [
    ...ARCH_FLAGS,
    // The prebuilt HAL is built by arm-none-eabi-gcc, whose EABI enums are as
    // small as they fit; clang's are int-sized unless told (HAL handles hold
    // enums: UART_HandleTypeDef would be laid out differently).
    "-fshort-enums",
    "-std=gnu17",
    "-nostdlibinc",
    ...projectIncludes.map((d) => `-I${PROJECT_ROOT}/${d}`),
    ...SDK_INCLUDES.map((d) => `-I${SDK_ROOT}/${d}`),
    "-isystem",
    `${SDK_ROOT}/${SDK_LIBC}`,
    "-DUSE_HAL_DRIVER",
    "-DSTM32F401xE",
    // -O0 as CubeIDE's Debug configuration: every line can take a breakpoint
    // and every variable can be watched (clang's -Og is -O1 and merges, for
    // example, the two HAL_Delay calls of hal-blinky's if/else into one).
    "-O0",
    "-g",
    "-Wall",
    "-ffunction-sections",
    "-fdata-sections",
    "-fno-color-diagnostics",
    "-fno-caret-diagnostics",
    "-fmessage-length=0",
  ];
}

/** Always linked (as objects: an archive member never replaces a weak symbol). */
export const SDK_OBJECTS = [
  "startup_stm32f401xe.o",
  "system_stm32f4xx.o",
  "stm32f4xx_it.o",
  "stm32f4xx_hal_msp.o",
  "clock_config.o",
  "syscalls.o",
].map((o) => `lib/obj/${o}`);
export const SDK_LIBS = ["lib/libgcc.a", "lib/libc_nano.a", "lib/libm.a", "lib/libnosys.a"];
export const SDK_LINKER_SCRIPT = "lib/STM32F401RETx_FLASH.ld";

/** Every file of the SDK bundle the link needs (checked when packing it). */
export const SDK_LINK_FILES = [
  SDK_LINKER_SCRIPT,
  "lib/crti.o",
  "lib/crtbegin.o",
  "lib/crtend.o",
  "lib/crtn.o",
  ...SDK_OBJECTS,
  "lib/libhal.a",
  ...SDK_LIBS,
];

export const objectPath = (src: string) => `${OUT}/${src.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/\.c$/, ".o")}`;
export const ELF_PATH = `${OUT}/app.elf`;

/** ld.lld's command line, the same order as arm-none-eabi-gcc's. */
export function linkArgs(objects: string[]): string[] {
  const s = (p: string) => `${SDK_ROOT}/${p}`;
  return [
    "ld.lld",
    "-o",
    ELF_PATH,
    "-T",
    s(SDK_LINKER_SCRIPT),
    "--gc-sections",
    s("lib/crti.o"),
    s("lib/crtbegin.o"),
    ...SDK_OBJECTS.map(s),
    ...objects,
    s("lib/libhal.a"),
    "--start-group",
    ...SDK_LIBS.map(s),
    "--end-group",
    s("lib/crtend.o"),
    s("lib/crtn.o"),
  ];
}

/** The toolchain files the site ships (web/public/toolchain/). */
export interface ToolchainManifest {
  /** Changes with any of the files (for caches and the build cache). */
  version: string;
  llvm: string;
  /** name → what is downloaded for it and its size there. */
  files: Record<string, { url: string; bytes: number; gzip: boolean }>;
  /** The SDK bundle. */
  sdk: { url: string; bytes: number };
}

/** Names the compiler package asks its asset loader for. */
export const TOOLCHAIN_ASSETS = ["llvm.core.wasm", "llvm.core2.wasm", "llvm.core3.wasm", "llvm.core4.wasm", "llvm-resources.tar"];
