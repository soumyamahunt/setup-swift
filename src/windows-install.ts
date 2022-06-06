import * as os from "os";
import * as fs from "fs";
import * as core from "@actions/core";
import * as toolCache from "@actions/tool-cache";
import * as io from "@actions/io";
import * as path from "path";
import * as semver from "semver";
import { ExecOptions, exec } from "@actions/exec";
import { System } from "./os";
import { swiftPackage, Package } from "./swift-versions";
import { setupKeys, verify } from "./gpg";

export async function install(version: string, system: System) {
  if (os.platform() !== "win32") {
    core.error("Trying to run windows installer on non-windows os");
    return;
  }

  const swiftPkg = swiftPackage(version, system);
  let swiftPath = toolCache.find(`swift-${system.name}`, version);

  if (swiftPath === null || swiftPath.trim().length == 0) {
    core.debug(`No cached installer found`);

    await setupKeys();

    let { exe, signature } = await download(swiftPkg);
    await verify(signature, exe);

    const exePath = await toolCache.cacheFile(
      exe,
      swiftPkg.name,
      `swift-${system.name}`,
      version
    );

    swiftPath = path.join(exePath, swiftPkg.name);
  } else {
    core.debug("Cached installer found");
  }

  core.debug("Running installer");

  const options: ExecOptions = {};
  options.listeners = {
    stdout: (data: Buffer) => {
      core.info(data.toString());
    },
    stderr: (data: Buffer) => {
      core.error(data.toString());
    },
  };
  let code = await exec(`"${swiftPath}" -q`, []);
  const systemDrive = process.env.SystemDrive ?? "C:";
  const swiftLibPath = path.join(systemDrive, "Library");
  const swiftInstallPath = path.join(
    swiftLibPath,
    "Developer",
    "Toolchains",
    "unknown-Asserts-development.xctoolchain",
    "usr\\bin"
  );

  if (code != 0 || !fs.existsSync(swiftInstallPath)) {
    core.setFailed(`Swift installer failed with exit code: ${code}`);
    return;
  }

  core.addPath(swiftInstallPath);

  const additionalPaths = [
    path.join(swiftLibPath, "Swift-development\\bin"),
    path.join(swiftLibPath, "icu-67\\usr\\bin"),
  ];
  additionalPaths.forEach((value, index, array) => core.addPath(value));

  core.debug(`Swift installed at "${swiftInstallPath}"`);
  await setupRequiredTools(swiftPkg);
}

async function download({ url, name }: Package) {
  core.debug("Downloading Swift for windows");

  let [exe, signature] = await Promise.all([
    toolCache.downloadTool(url),
    toolCache.downloadTool(`${url}.sig`),
  ]);

  core.debug("Swift download complete");
  return { exe, signature, name };
}

/// get vswhere and vs_installer paths
async function getVsToolsPath() {
  // check to see if we are using a specific path for vswhere
  let vswhereToolExe = "";
  // Env variable for self-hosted runner to provide custom path
  const VSWHERE_PATH = process.env.VSWHERE_PATH;

  if (VSWHERE_PATH) {
    // specified a path for vswhere, use it
    core.debug(`Using given vswhere-path: ${VSWHERE_PATH}`);
    vswhereToolExe = path.join(VSWHERE_PATH, "vswhere.exe");
  } else {
    // check in PATH to see if it is there
    try {
      const vsWhereInPath: string = await io.which("vswhere", true);
      core.debug(`Found tool in PATH: ${vsWhereInPath}`);
      vswhereToolExe = vsWhereInPath;
    } catch {
      // fall back to VS-installed path
      vswhereToolExe = path.join(
        process.env["ProgramFiles(x86)"] as string,
        "Microsoft Visual Studio\\Installer\\vswhere.exe"
      );
      core.debug(`Trying Visual Studio-installed path: ${vswhereToolExe}`);
    }
  }

  if (!fs.existsSync(vswhereToolExe)) {
    core.setFailed("Action requires the path to where vswhere.exe exists");

    throw new Error();
  }

  return vswhereToolExe;
}

export interface VsRequirement {
  version: string;
  components: string[];
}

/// Setup different version and component requirement
/// based on swift versions if required
function vsRequirement({ version }: Package): VsRequirement {
  return {
    version: "16",
    components: [
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "Microsoft.VisualStudio.Component.Windows10SDK.17763",
    ],
  };
}

/// Do swift version based additional support files setup
async function setupSupportFiles({ version }: Package, vsInstallPath: string) {
  if (semver.lt(version, "5.4.2")) {
    const nativeToolsScriptx86 = path.join(
      vsInstallPath,
      "VC\\Auxiliary\\Build\\vcvars32.bat"
    );
    const copyCommands = [
      'copy /Y %SDKROOT%\\usr\\share\\ucrt.modulemap "%UniversalCRTSdkDir%\\Include\\%UCRTVersion%\\ucrt\\module.modulemap"',
      'copy /Y %SDKROOT%\\usr\\share\\visualc.modulemap "%VCToolsInstallDir%\\include\\module.modulemap"',
      'copy /Y %SDKROOT%\\usr\\share\\visualc.apinotes "%VCToolsInstallDir%\\include\\visualc.apinotes"',
      'copy /Y %SDKROOT%\\usr\\share\\winsdk.modulemap "%UniversalCRTSdkDir%\\Include\\%UCRTVersion%\\um\\module.modulemap"',
    ].join("&&");
    let code = await exec(
      "cmd /c",
      [`""${nativeToolsScriptx86}"&&${copyCommands}"`],
      { windowsVerbatimArguments: true }
    );
    core.info(`Ran command for swift and exited with code: ${code}`);
  }
}

export interface VisualStudio {
  installationPath: string;
  properties: VsProperties;
}

export interface VsProperties {
  setupEngineFilePath: string;
}

/// set up required tools for swift on windows
async function setupRequiredTools(pkg: Package) {
  const vswhereExe = await getVsToolsPath();
  const requirement = vsRequirement(pkg);
  const vsWhereExec =
    `-products * ` +
    `-format json -utf8 ` +
    `-latest -version "${requirement.version}"`;

  let payload = "";
  const options: ExecOptions = {};
  options.listeners = {
    stdout: (data: Buffer) => {
      payload = payload.concat(data.toString("utf-8"));
    },
    stderr: (data: Buffer) => {
      core.error(data.toString());
    },
  };

  // execute the find putting the result of the command in the options vsInstallPath
  await exec(`"${vswhereExe}" ${vsWhereExec}`, [], options);
  core.info(`got payload: ${payload}`);

  let vsInstallations: VisualStudio[] = JSON.parse(payload);
  core.info(`array: ${JSON.stringify(vsInstallations)}`);
  let vs = JSON.parse(payload)[0];
  core.info(`obj: ${JSON.stringify(vs)}`);
  if (!vs.installationPath) {
    core.setFailed(
      `Unable to find any visual studio installation for version: ${requirement.version}.`
    );
    return;
  }

  const vsInstallerExec =
    `modify  --installPath "${vs.installationPath}" ` +
    requirement.components.reduce((previous, current, currentIndex, array) => {
      return `${previous} --add "${current}"`;
    }) +
    ` --quiet`;

  // install required visual studio components
  const code = await exec(
    `"${vs.properties.setupEngineFilePath}" ${vsInstallerExec}`,
    []
  );
  if (code != 0) {
    core.setFailed(
      `Visual Studio installer failed to install required components with exit code: ${code}.`
    );
    return;
  }

  await setupSupportFiles(pkg, vs.installationPath);
}
