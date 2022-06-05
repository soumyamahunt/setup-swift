import * as os from "os";
import * as fs from "fs";
import * as core from "@actions/core";
import * as toolCache from "@actions/tool-cache";
import * as io from "@actions/io";
import * as path from "path";
import { exec } from "@actions/exec";
import { System } from "./os";
import { swiftPackage, Package } from "./swift-versions";

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

  await exec(`"${swiftPath}"`, ["-q"]);
  core.addPath(
    "%SystemDrive%\\Library\\Developer\\Toolchains\\unknown-Asserts-development.xctoolchain\\usr\\bin"
  );

  core.debug("Swift installed");
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

async function getVsWherePath() {
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

  if (!fs.existsSync(vswhereToolExe)) {
    core.setFailed(
      "setup-msbuild requires the path to where vswhere.exe exists"
    );

    return;
  }

  return vswhereToolExe;
}

function vsVersionRange({ version }: Package) {
  return "[16,17)";
}

async function setupRequiredTools(pkg: Package) {
  let vswhereToolExe = await getVsWherePath();
  let vsWhereExec =
    `-products * ` +
    `-property installationPath ` +
    `-latest -version "${vsVersionRange(pkg)}"`;
}
