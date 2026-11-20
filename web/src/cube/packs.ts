// The STM32CubeF4 driver bundles the configuration tool (M36) can put in a
// project's Drivers/ folder. Each is a version of ST's HAL driver, CMSIS
// device files and Arm's CMSIS core, vendored in firmware/vendor (BSD-3 /
// Apache-2.0) and packed by scripts/editor-sdk.mjs into
// public/cube/<id>.tar.gz.bin with a listing in public/cube/packs.json.
// Projects reference a bundle by id; its files are read-only and never
// stored in the project. The in-browser build links the prebuilt HAL of the
// same sources (firmware/editor-sdk). To add a version: vendor it next to
// the current one, add an entry here and to PACK_SOURCES in the script, and
// build its libhal.a (see docs/config-tool.md).

export interface DriverPack {
  id: string;
  /** Shown in the version menu. */
  label: string;
  /** What CubeMX writes as ProjectManager.FirmwarePackage. */
  firmwarePackage: string;
  hal: string;
  cmsisDevice: string;
  cmsisCore: string;
}

export const PACKS: DriverPack[] = [
  {
    id: "cubef4-hal-1.8.6",
    label: "STM32CubeF4 (HAL 1.8.6 · CMSIS F4 2.6.11)",
    firmwarePackage: "STM32Cube FW_F4 V1.28.3",
    hal: "1.8.6",
    cmsisDevice: "2.6.11",
    cmsisCore: "5.x",
  },
];

export const DEFAULT_PACK = PACKS[0];
export const packById = (id: string | undefined) => PACKS.find((p) => p.id === id) ?? DEFAULT_PACK;

/** Where a bundle is served (relative to the site). */
export const packUrl = (id: string) => `cube/${id}.tar.gz.bin`;
export const PACKS_INDEX = "cube/packs.json";

/**
 * Files of a project that come from the bundle (as CubeIDE lays them out),
 * besides Drivers/: the start-up code, SystemInit and the linker script.
 * Read-only in the editor; the build uses their prebuilt objects.
 */
export const PACK_PROJECT_FILES = ["Core/Startup/startup_stm32f401retx.s", "Core/Src/system_stm32f4xx.c", "STM32F401RETX_FLASH.ld"];

/** Paths inside a bundle tar: `pack/Drivers/...`, `pack/Core/...`, `pack/STM32F401RETX_FLASH.ld`. */
export const PACK_PREFIX = "pack/";

export interface PackListing {
  id: string;
  url: string;
  bytes: number;
  /** Every file's project path and size. */
  files: { path: string; bytes: number }[];
}
