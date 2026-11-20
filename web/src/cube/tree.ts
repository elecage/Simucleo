// A configuration-tool project as an STM32CubeIDE project tree (M36):
// creating it from a configuration, regenerating with the student's USER
// CODE kept, the tree the editor shows (Core/Inc, Core/Src, Core/Startup,
// Drivers/… from the selected STM32CubeF4 bundle, the .ioc, the linker
// script), a zip that opens in STM32CubeIDE (with minimal .project and
// .cproject), and importing a CubeIDE project (folder or zip). Pure apart
// from the zip writer's CompressionStream; unit tested.
import type { SourceFile } from "../code/build.ts";
import { MAIN_C, type CodeProject } from "../code/project.ts";
import { generate, GENERATED, ONCE, starterUserCode, SYSCALLS_C, SYSMEM_C } from "./codegen.ts";
import { clone, type CubeConfig } from "./config.ts";
import { exportIoc, parseIoc } from "./ioc.ts";
import { DEFAULT_PACK, packById, PACK_PROJECT_FILES } from "./packs.ts";
import { editsOutsideRegions, mergeUserCode, setRegion } from "./usercode.ts";
import { writeZipAsync } from "./zipwrite.ts";

export interface PackFile {
  /** Project path: `Drivers/STM32F4xx_HAL_Driver/Inc/stm32f4xx_hal.h`, `Core/Startup/…`. */
  path: string;
  data: Uint8Array;
}

/** A project name CubeIDE and the file system accept. */
export function safeProjectName(name: string): string {
  const n = name.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (n || "simucleo").slice(0, 48);
}

const iocName = (c: CubeConfig) => `${safeProjectName(c.projectName)}.ioc`;

/** A new project of the tool: generated files, the starter user code, syscalls/sysmem. */
export function newCubeProject(c0: CubeConfig): CodeProject {
  const c = clone(c0);
  c.projectName = safeProjectName(c.projectName);
  if (!c.drivers) c.drivers = DEFAULT_PACK.id;
  const files: SourceFile[] = generate(c).map((f) => {
    if (f.path !== MAIN_C) return f;
    let t = f.text;
    for (const [k, v] of Object.entries(starterUserCode(c))) t = setRegion(t, k, v);
    return { path: f.path, text: t };
  });
  files.push({ path: "Core/Src/syscalls.c", text: SYSCALLS_C }, { path: "Core/Src/sysmem.c", text: SYSMEM_C });
  return { template: "cube", files: sortFiles(files), active: MAIN_C, ioc: exportIoc(c), drivers: c.drivers };
}

/** Core/Inc, then Core/Src (main.c first), then the rest. */
export function sortFiles(files: SourceFile[]): SourceFile[] {
  const rank = (p: string) => (p === MAIN_C ? 0 : p.startsWith("Core/Src/") ? 1 : p.startsWith("Core/Inc/") ? 2 : 3);
  return [...files].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

export interface FileChange {
  path: string;
  before: string | null;
  after: string;
  /** Regions whose user code was put back. */
  kept: string[];
  /** Regions that are gone; their code is in the Orphaned block. */
  orphaned: string[];
  /** Lines changed outside USER CODE that regeneration overwrites. */
  lostEdits: number;
}

/**
 * What regenerating `project` for `c` does, file by file: the generated
 * files with the user code of the current ones merged in; syscalls.c and
 * sysmem.c only when missing. Nothing is applied: see `applyRegeneration`.
 */
export function planRegeneration(project: CodeProject, c0: CubeConfig): FileChange[] {
  const c = clone(c0);
  c.projectName = safeProjectName(c.projectName);
  const cur = new Map(project.files.map((f) => [f.path, f.text]));
  const previous = new Map(project.ioc ? generate({ ...parseIoc(project.ioc).config, projectName: c.projectName }).map((f) => [f.path, f.text]) : []);
  const out: FileChange[] = [];
  for (const f of generate(c)) {
    const before = cur.get(f.path) ?? null;
    const m = mergeUserCode(f.text, before);
    // Edits outside the regions: what differs from the code the project's own (old) configuration generates.
    const base = previous.get(f.path);
    out.push({ path: f.path, before, after: m.text, kept: m.kept, orphaned: m.orphaned, lostEdits: before && base !== undefined ? editsOutsideRegions(base, before) : 0 });
  }
  for (const [path, text] of [
    ["Core/Src/syscalls.c", SYSCALLS_C],
    ["Core/Src/sysmem.c", SYSMEM_C],
  ] as const) {
    if (!cur.has(path)) out.push({ path, before: null, after: text, kept: [], orphaned: [], lostEdits: 0 });
  }
  return out;
}

export function applyRegeneration(project: CodeProject, c0: CubeConfig, plan = planRegeneration(project, c0)): CodeProject {
  const c = clone(c0);
  c.projectName = safeProjectName(c.projectName);
  const files = new Map(project.files.map((f) => [f.path, f.text]));
  for (const ch of plan) files.set(ch.path, ch.after);
  return {
    ...project,
    template: "cube",
    files: sortFiles([...files].map(([path, text]) => ({ path, text }))),
    ioc: exportIoc(c),
    drivers: c.drivers || project.drivers || DEFAULT_PACK.id,
  };
}

/** The configuration of a cube project (from its .ioc). */
export function projectConfig(p: CodeProject): { config: CubeConfig; warnings: string[] } {
  if (!p.ioc) return { config: { ...parseIoc("").config, drivers: p.drivers ?? DEFAULT_PACK.id }, warnings: ["프로젝트에 .ioc가 없습니다."] };
  const r = parseIoc(p.ioc);
  if (p.drivers) r.config.drivers = p.drivers;
  return r;
}

// ------------------------------------------------------------------ tree

export type NodeKind = "user" | "generated" | "pack" | "ioc" | "ide";

export interface TreeNode {
  path: string;
  kind: NodeKind;
  readOnly: boolean;
  bytes?: number;
}

/** Every file of the project as CubeIDE shows it, sorted like its Project Explorer. */
export function projectTree(p: CodeProject, packFiles: { path: string; bytes: number }[]): TreeNode[] {
  const cfg = projectConfig(p).config;
  const nodes: TreeNode[] = [];
  const gen = new Set<string>([...GENERATED, ...ONCE]);
  for (const f of p.files) nodes.push({ path: f.path, kind: gen.has(f.path) ? "generated" : "user", readOnly: false, bytes: new TextEncoder().encode(f.text).length });
  for (const f of packFiles) if (!nodes.some((n) => n.path === f.path)) nodes.push({ path: f.path, kind: "pack", readOnly: true, bytes: f.bytes });
  nodes.push({ path: iocName(cfg), kind: "ioc", readOnly: true });
  nodes.push({ path: ".project", kind: "ide", readOnly: true }, { path: ".cproject", kind: "ide", readOnly: true });
  return nodes.sort((a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path));
}

const order = (p: string) => (p.startsWith("Core/") ? 0 : p.startsWith("Drivers/") ? 1 : p.startsWith(".") ? 3 : 2);

// ------------------------------------------------------------------ CubeIDE files

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function dotProject(name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
	<name>${xml(name)}</name>
	<comment></comment>
	<projects>
	</projects>
	<buildSpec>
		<buildCommand>
			<name>org.eclipse.cdt.managedbuilder.core.genmakebuilder</name>
			<triggers>clean,full,incremental,</triggers>
			<arguments>
			</arguments>
		</buildCommand>
		<buildCommand>
			<name>org.eclipse.cdt.managedbuilder.core.ScannerConfigBuilder</name>
			<triggers>full,incremental,</triggers>
			<arguments>
			</arguments>
		</buildCommand>
	</buildSpec>
	<natures>
		<nature>com.st.stm32cube.ide.mcu.MCUProjectNature</nature>
		<nature>com.st.stm32cube.ide.mcu.MCUCubeProjectNature</nature>
		<nature>org.eclipse.cdt.core.cnature</nature>
		<nature>com.st.stm32cube.ide.mcu.MCUCubeIdeServicesRevAev2ProjectNature</nature>
		<nature>com.st.stm32cube.ide.mcu.MCUAdvancedStructureProjectNature</nature>
		<nature>com.st.stm32cube.ide.mcu.MCUSingleCpuProjectNature</nature>
		<nature>com.st.stm32cube.ide.mcu.MCURootProjectNature</nature>
		<nature>org.eclipse.cdt.managedbuilder.core.managedBuildNature</nature>
		<nature>org.eclipse.cdt.managedbuilder.core.ScannerConfigNature</nature>
	</natures>
</projectDescription>
`;
}

const INCLUDES = ["../Core/Inc", "../Drivers/STM32F4xx_HAL_Driver/Inc", "../Drivers/STM32F4xx_HAL_Driver/Inc/Legacy", "../Drivers/CMSIS/Device/ST/STM32F4xx/Include", "../Drivers/CMSIS/Include"];
const DEFINES = ["DEBUG", "USE_HAL_DRIVER", "STM32F401xE"];

/** A minimal managed-build .cproject (Debug, MCU ARM GCC, the Nucleo-F401RE). */
export function dotCproject(name: string): string {
  const id = "com.st.stm32cube.ide.mcu.gnu.managedbuild";
  const cfg = `${id}.config.exe.debug.1336`;
  const opt = (sup: string, value: string, n: number) => `\t\t\t\t\t\t\t\t<option id="${sup}.${n}" superClass="${sup}" useByScannerDiscovery="false" value="${xml(value)}" valueType="string"/>`;
  const list = (sup: string, type: string, values: string[], n: number) =>
    `\t\t\t\t\t\t\t\t\t<option IS_BUILTIN_EMPTY="false" IS_VALUE_EMPTY="false" id="${sup}.${n}" superClass="${sup}" useByScannerDiscovery="false" valueType="${type}">\n${values.map((v) => `\t\t\t\t\t\t\t\t\t\t<listOptionValue builtIn="false" value="${xml(v)}"/>`).join("\n")}\n\t\t\t\t\t\t\t\t\t</option>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?fileVersion 4.0.0?><cproject storage_type_id="org.eclipse.cdt.core.XmlProjectDescriptionStorage">
	<storageModule moduleId="org.eclipse.cdt.core.settings">
		<cconfiguration id="${cfg}">
			<storageModule buildSystemId="org.eclipse.cdt.managedbuilder.core.configurationDataProvider" id="${cfg}" moduleId="org.eclipse.cdt.core.settings" name="Debug">
				<externalSettings/>
				<extensions>
					<extension id="org.eclipse.cdt.core.ELF" point="org.eclipse.cdt.core.BinaryParser"/>
					<extension id="org.eclipse.cdt.core.GASErrorParser" point="org.eclipse.cdt.core.ErrorParser"/>
					<extension id="org.eclipse.cdt.core.GmakeErrorParser" point="org.eclipse.cdt.core.ErrorParser"/>
					<extension id="org.eclipse.cdt.core.GLDErrorParser" point="org.eclipse.cdt.core.ErrorParser"/>
					<extension id="org.eclipse.cdt.core.CWDLocator" point="org.eclipse.cdt.core.ErrorParser"/>
					<extension id="org.eclipse.cdt.core.GCCErrorParser" point="org.eclipse.cdt.core.ErrorParser"/>
				</extensions>
			</storageModule>
			<storageModule moduleId="cdtBuildSystem" version="4.0.0">
				<configuration artifactExtension="elf" artifactName="\${ProjName}" buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe" buildProperties="org.eclipse.cdt.build.core.buildArtefactType=org.eclipse.cdt.build.core.buildArtefactType.exe,org.eclipse.cdt.build.core.buildType=org.eclipse.cdt.build.core.buildType.debug" cleanCommand="rm -rf" description="" id="${cfg}" name="Debug" parent="${id}.config.exe.debug">
					<folderInfo id="${cfg}." name="/" resourcePath="">
						<toolChain id="${id}.toolchain.exe.debug.1" name="MCU ARM GCC" superClass="${id}.toolchain.exe.debug">
${opt(`${id}.option.target_mcu`, "STM32F401RETx", 10)}
${opt(`${id}.option.target_cpuid`, "0", 11)}
${opt(`${id}.option.target_coreid`, "0", 12)}
${opt(`${id}.option.fpu`, `${id}.option.fpu.value.fpv4-sp-d16`, 13)}
${opt(`${id}.option.floatabi`, `${id}.option.floatabi.value.hard`, 14)}
${opt(`${id}.option.target_board`, "NUCLEO-F401RE", 15)}
							<targetPlatform archList="all" binaryParser="org.eclipse.cdt.core.ELF" id="${id}.targetplatform.1" isAbstract="false" osList="all" superClass="${id}.targetplatform"/>
							<builder buildPath="\${workspace_loc:/${xml(name)}}/Debug" id="${id}.builder.1" keepEnvironmentInBuildfile="false" managedBuildOn="true" name="Gnu Make Builder" parallelBuildOn="true" parallelizationNumber="optimal" superClass="${id}.builder"/>
							<tool id="${id}.tool.assembler.1" name="MCU GCC Assembler" superClass="${id}.tool.assembler">
								<option id="${id}.tool.assembler.option.debuglevel.1" superClass="${id}.tool.assembler.option.debuglevel" value="${id}.tool.assembler.option.debuglevel.value.g3" valueType="enumerated"/>
								<inputType id="${id}.tool.assembler.input.1" superClass="${id}.tool.assembler.input"/>
							</tool>
							<tool id="${id}.tool.c.compiler.1" name="MCU GCC Compiler" superClass="${id}.tool.c.compiler">
								<option id="${id}.tool.c.compiler.option.debuglevel.1" superClass="${id}.tool.c.compiler.option.debuglevel" value="${id}.tool.c.compiler.option.debuglevel.value.g3" valueType="enumerated"/>
								<option id="${id}.tool.c.compiler.option.optimization.level.1" superClass="${id}.tool.c.compiler.option.optimization.level" useByScannerDiscovery="false"/>
${list(`${id}.tool.c.compiler.option.definedsymbols`, "definedSymbols", DEFINES, 2)}
${list(`${id}.tool.c.compiler.option.includepaths`, "includePath", INCLUDES, 3)}
								<inputType id="${id}.tool.c.compiler.input.c.1" superClass="${id}.tool.c.compiler.input.c"/>
							</tool>
							<tool id="${id}.tool.c.linker.1" name="MCU GCC Linker" superClass="${id}.tool.c.linker">
								<option id="${id}.tool.c.linker.option.script.1" superClass="${id}.tool.c.linker.option.script" value="\${workspace_loc:/\${ProjName}/STM32F401RETX_FLASH.ld}" valueType="string"/>
								<inputType id="${id}.tool.c.linker.input.1" superClass="${id}.tool.c.linker.input">
									<additionalInput kind="additionalinputdependency" paths="$(USER_OBJS)"/>
									<additionalInput kind="additionalinput" paths="$(LIBS)"/>
								</inputType>
							</tool>
							<tool id="${id}.tool.archiver.1" name="MCU GCC Archiver" superClass="${id}.tool.archiver"/>
							<tool id="${id}.tool.size.1" name="MCU Size" superClass="${id}.tool.size"/>
							<tool id="${id}.tool.objdump.listfile.1" name="MCU Output Converter list file" superClass="${id}.tool.objdump.listfile"/>
						</toolChain>
					</folderInfo>
					<sourceEntries>
						<entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="Core"/>
						<entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="Drivers"/>
					</sourceEntries>
				</configuration>
			</storageModule>
			<storageModule moduleId="org.eclipse.cdt.core.externalSettings"/>
		</cconfiguration>
	</storageModule>
	<storageModule moduleId="cdtBuildSystem" version="4.0.0">
		<project id="${xml(name)}.null.1" name="${xml(name)}"/>
	</storageModule>
	<storageModule moduleId="scannerConfiguration">
		<autodiscovery enabled="true" problemReportingEnabled="true" selectedProfileId=""/>
	</storageModule>
	<storageModule moduleId="org.eclipse.cdt.core.LanguageSettingsProviders"/>
	<storageModule moduleId="refreshScope" versionNumber="2">
		<configuration configurationName="Debug">
			<resource resourceType="PROJECT" workspacePath="/${xml(name)}"/>
		</configuration>
	</storageModule>
</cproject>
`;
}

// ------------------------------------------------------------------ zip

/** Every file of the exported project, under `<name>/`. */
export function exportEntries(p: CodeProject, packFiles: PackFile[]): { path: string; data: Uint8Array | string }[] {
  const cfg = projectConfig(p).config;
  const name = safeProjectName(cfg.projectName);
  const out: { path: string; data: Uint8Array | string }[] = [];
  const seen = new Set<string>();
  const add = (path: string, data: Uint8Array | string) => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ path: `${name}/${path}`, data });
  };
  add(".project", dotProject(name));
  add(".cproject", dotCproject(name));
  add(`${name}.ioc`, p.ioc ?? exportIoc(cfg));
  for (const f of sortFiles(p.files)) add(f.path, f.text);
  for (const f of packFiles) add(f.path, f.data);
  return out;
}

export async function exportZip(p: CodeProject, packFiles: PackFile[]): Promise<Uint8Array> {
  return writeZipAsync(exportEntries(p, packFiles));
}

// ------------------------------------------------------------------ import

export interface ImportedFile {
  /** Path as picked or inside the zip (`blinky/Core/Src/main.c`). */
  path: string;
  data: Uint8Array;
}

export interface ImportResult {
  project: CodeProject;
  warnings: string[];
  /** The project folder's name (where the .ioc was). */
  root: string;
}

const SKIP = /(^|\/)(Debug|Release|\.settings|\.metadata|\.git|build)\//i;

/**
 * A CubeIDE project (folder or unzipped) → a cube project: the .ioc becomes
 * the configuration, the C files under Core/ the student's files. Drivers/,
 * build folders and the bundle's own files (start-up, SystemInit, linker
 * script) are left out: the selected bundle provides them.
 */
export function importCubeProject(files: ImportedFile[], decode: (b: Uint8Array) => string | null): ImportResult {
  const warnings: string[] = [];
  const iocs = files.filter((f) => f.path.toLowerCase().endsWith(".ioc") && !SKIP.test(f.path)).sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  if (!iocs.length) throw new Error("이 폴더(zip)에 .ioc 파일이 없습니다. CubeMX/CubeIDE 프로젝트의 폴더를 고르세요.");
  if (iocs.length > 1) warnings.push(`.ioc가 ${iocs.length}개 있어 ${iocs[0].path}을(를) 씁니다.`);
  const ioc = iocs[0];
  const root = ioc.path.includes("/") ? ioc.path.slice(0, ioc.path.lastIndexOf("/") + 1) : "";
  const iocText = decode(ioc.data) ?? "";
  const parsed = parseIoc(iocText);
  warnings.push(...parsed.warnings);
  const sources: SourceFile[] = [];
  let skippedPack = 0;
  for (const f of files) {
    if (!f.path.startsWith(root)) continue;
    const rel = f.path.slice(root.length);
    if (SKIP.test(rel) || !rel.startsWith("Core/")) continue;
    if (PACK_PROJECT_FILES.includes(rel) || /^Core\/Startup\//.test(rel)) {
      skippedPack++;
      continue;
    }
    if (!/\.(c|h)$/.test(rel)) continue;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(rel)) {
      warnings.push(`${rel}: 파일 이름에 쓸 수 없는 글자가 있어 건너뜁니다.`);
      continue;
    }
    const text = decode(f.data);
    if (text === null) {
      warnings.push(`${rel}: 텍스트 파일이 아니라 건너뜁니다.`);
      continue;
    }
    sources.push({ path: rel, text });
  }
  if (skippedPack) warnings.push(`시작 코드·SystemInit(Core/Startup, system_stm32f4xx.c)은 고른 STM32CubeF4 묶음의 것을 씁니다.`);
  const cfg = parsed.config;
  cfg.projectName = safeProjectName(root.replace(/\/$/, "").split("/").pop() || cfg.projectName);
  if (!sources.some((s) => s.path === MAIN_C)) {
    warnings.push("Core/Src/main.c가 없어 설정에서 새로 만듭니다.");
  }
  // Fill in what the project lacks from the configuration (generated files, syscalls).
  let project: CodeProject = { template: "cube", files: sortFiles(sources), active: MAIN_C, ioc: exportIoc(cfg), drivers: cfg.drivers || packById(undefined).id };
  const missing = planRegeneration(project, cfg).filter((ch) => ch.before === null);
  if (missing.length) project = { ...project, files: sortFiles([...project.files, ...missing.map((m) => ({ path: m.path, text: m.after }))]) };
  return { project, warnings, root: root.replace(/\/$/, "") };
}
