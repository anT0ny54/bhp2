// Guard against Sharp native-binary drift.
//
// netlify.toml packages the ROOT-pinned @img/* native packages, so a
// Dependabot bump of `sharp` alone (without the four matching @img/* pins)
// could ship mismatched native binaries. Compare all declared pins with the
// installed Sharp package, then verify the native pair selected for this
// Linux runtime is actually installed at the required versions.
import fs from "node:fs";

const readJson = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), "utf8"));

const pkg = readJson("../package.json");
let sharpPkg;
try {
  sharpPkg = readJson("../node_modules/sharp/package.json");
} catch {
  console.error("Sharp native pin check: node_modules/sharp is not installed.");
  console.error("Run `yarn install` first, then re-run this check.");
  process.exit(1);
}

const REQUIRED = [
  "@img/sharp-linux-x64",
  "@img/sharp-linux-arm64",
  "@img/sharp-libvips-linux-x64",
  "@img/sharp-libvips-linux-arm64",
];

const errors = [];
const expectedSharpVersion = pkg.dependencies?.sharp;
if (!expectedSharpVersion) {
  errors.push("sharp: not pinned in package.json dependencies");
} else if (sharpPkg.version !== expectedSharpVersion) {
  errors.push(`sharp: package.json pins ${expectedSharpVersion} but installed sharp is ${sharpPkg.version}`);
}

for (const name of REQUIRED) {
  const expected = pkg.optionalDependencies?.[name];
  const actual = sharpPkg.optionalDependencies?.[name];
  if (!expected) {
    errors.push(`${name}: not pinned in package.json optionalDependencies`);
  } else if (expected !== actual) {
    errors.push(`${name}: package.json pins ${expected} but sharp ${sharpPkg.version} requires ${actual}`);
  }
}

// Netlify's configured runtime is Linux x64. Also validate the native pair on
// Linux ARM64 or musl hosts when this script is run there. Other developer
// platforms still get the full declaration check above; their platform-specific
// native packages are intentionally not required in the install.
const isLinux = process.platform === "linux";
const isGlibc = Boolean(process.report?.getReport?.().header?.glibcVersionRuntime);
const linuxVariant = isGlibc ? "linux" : "linuxmusl";
const platformPackages = isLinux && ["x64", "arm64"].includes(process.arch)
  ? [
      `@img/sharp-${linuxVariant}-${process.arch}`,
      `@img/sharp-libvips-${linuxVariant}-${process.arch}`,
    ]
  : [];

for (const name of platformPackages) {
  const requiredVersion = sharpPkg.optionalDependencies?.[name];
  if (!requiredVersion) {
    errors.push(`${name}: not declared by installed sharp ${sharpPkg.version}`);
    continue;
  }

  let installed;
  try {
    installed = readJson(`../node_modules/${name}/package.json`);
  } catch {
    errors.push(`${name}: required native package is not installed for ${process.platform}/${process.arch}`);
    continue;
  }

  if (installed.version !== requiredVersion) {
    errors.push(`${name}: installed version is ${installed.version}, but sharp ${sharpPkg.version} requires ${requiredVersion}`);
  }
}

if (errors.length > 0) {
  console.error("Sharp version/pin mismatch:");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("Install the exact sharp and @img/* versions declared in package.json; when upgrading, bump the native pins together with sharp.");
  process.exit(1);
}

console.log(`Sharp ${sharpPkg.version} pins match package.json${platformPackages.length ? `; ${platformPackages.join(" and ")} are installed at the required versions` : ""}.`);
