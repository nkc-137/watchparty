/**
 * Test runner for the extension.
 *
 * The sources are browser-targeted TypeScript, so they are bundled for Node
 * with the esbuild that already builds the extension — no test framework and no
 * extra toolchain. Bundling also resolves the cross-package import of the
 * server's protocol copy, which one test compares against.
 */
import { build } from "esbuild";
import { pathToFileURL } from "url";
import { rmSync } from "fs";

const outfile = "test/.build/unit.mjs";

await build({
  entryPoints: ["test/unit.test.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: "inline",
  logLevel: "warning",
});

try {
  await import(pathToFileURL(outfile).href);
} finally {
  rmSync("test/.build", { recursive: true, force: true });
}
