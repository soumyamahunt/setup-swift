import * as os from "os";
import * as fs from "fs";
import * as core from "@actions/core";
import * as toolCache from "@actions/tool-cache";
import * as io from "@actions/io";
import * as path from "path";
import { ExecOptions, exec } from "@actions/exec";
import { System } from "./os";
import { swiftPackage, Package } from "./swift-versions";
import { stderr } from "process";

export async function install(version: string, system: System) {
  if (os.platform() !== "win32") {
    core.error("Trying to run windows installer on non-windows os");
    return;
  }

  let swiftPath = toolCache.find(`swift-${system.name}`, version);

  if (swiftPath === null || swiftPath.trim().length == 0) {
    core.debug(`No cached installer found`);

    const swiftPkg = swiftPackage(version, system);
    let { exe, signature } = await download(swiftPkg);

    const exePath = await toolCache.cacheFile(
      exe,
      swiftPkg.name,
      `swift-${system.name}`,
      version
    );

    swiftPath = path.join(exePath, swiftPkg.name);
    //await verify(signature, pkg);
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
  let result = fs.existsSync(
    "C:\\Library\\Developer\\Toolchains\\unknown-Asserts-development.xctoolchain\\usr\\bin"
  );
  const systemDrive = process.env.SystemDrive ?? "C:";
  core.info(
    `exit code ${code} and result ${result} and sysdrive: ${systemDrive}`
  );
  const swiftInstallPath = path.join(
    systemDrive,
    "Library",
    "Developer",
    "Toolchains",
    "unknown-Asserts-development.xctoolchain",
    "usr\\bin"
  );
  core.addPath(swiftInstallPath);

  core.debug(`Swift installed at "${swiftInstallPath}"`);
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

export interface VisualStudio {
  vswhere: string;
  vsinstaller: string;
}

async function getVsWherePath(): Promise<VisualStudio> | never {
  // check to see if we are using a specific path for vswhere
  let vswhereToolExe = "";
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

  let vsinstallerToolExe = path.join(
    path.dirname(vswhereToolExe),
    "vs_installer.exe"
  );
  if (!fs.existsSync(vswhereToolExe) || !fs.existsSync(vsinstallerToolExe)) {
    core.setFailed(
      "Action requires the path to where vswhere.exe and vs_installer.exe exists"
    );

    throw new Error();
  }

  return { vswhere: vswhereToolExe, vsinstaller: vsinstallerToolExe };
}

export interface VsRequirement {
  versionRange: string;
  components: string[];
}

function vsRequirement({ version }: Package): VsRequirement {
  return {
    versionRange: "[16,17)",
    components: [
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "Microsoft.VisualStudio.Component.Windows10SDK.17763",
    ],
  };
}

async function setupRequiredTools(pkg: Package) {
  const { vswhere, vsinstaller } = await getVsWherePath();
  const requirement = vsRequirement(pkg);
  const vsWhereExec =
    `-products * ` +
    `-property installationPath ` +
    `-latest -version "${requirement.versionRange}"`;

  let vsInstallPath = "";
  const options: ExecOptions = {};
  options.listeners = {
    stdout: (data: Buffer) => {
      const installationPath = data.toString().trim();
      core.debug(`Found installation path: ${installationPath}`);
      vsInstallPath = installationPath;
    },
  };

  // execute the find putting the result of the command in the options foundToolPath
  await exec(`"${vswhere}" ${vsWhereExec}`, [], options);

  const vsInstallerExec =
    `modify  --installPath "${vsInstallPath}" ` +
    requirement.components.reduce((previous, current, currentIndex, array) => {
      return `${previous} --add "${current}"`;
    }) +
    ` --quiet`;

  // execute the find putting the result of the command in the options foundToolPath
  await exec(`"${vsinstaller}" ${vsInstallerExec}`, []);
}
