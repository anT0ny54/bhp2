// Guard against Sharp native-binary drift.
//
// netlify.toml packages the ROOT-pinned @img/* native packages, so a
// Dependabot bump of `sharp` alone (without the four matching @img/* pins)
// would ship mismatched native binaries and the function would fail at
// runtime. This check compares package.json's pins against the
// optionalDependencies that the INSTALLED sharp actually requires.
import fs from "node:fs";

const readJson = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), "utf8"));

const pkg = readJson("../package.json");
const sharpPkg = readJson("../node_modules/sharp/package.json");

const REQUIRED = [
  "@img/sharp-linux-x64",
  "@img/sharp-linux-arm64",
  "@img/sharp-libvips-linux-x64",
  "@img/sharp-libvips-linux-arm64",
];

const errors = [];
for (const name of REQUIRED) {
  const expected = pkg.optionalDependencies?.[name];
  const actual = sharpPkg.optionalDependencies?.[name];
  if (!expected) {
    errors.push(`${name}: not pinned in package.json optionalDependencies`);
  } else if (expected !== actual) {
    errors.push(`${name}: package.json pins ${expected} but sharp ${sharpPkg.version} requires ${actual}`);
  }
}

if (errors.length > 0) {
  console.error("Sharp native pin mismatch:");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("Bump the four @img/* pins together with sharp.");
  process.exit(1);
}

console.log(`Sharp native pins match sharp ${sharpPkg.version}.`);
