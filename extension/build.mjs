import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";

mkdirSync(outdir, { recursive: true });

// Static assets copied verbatim into dist/.
for (const f of ["manifest.json", "src/popup.html", "src/chat.css"]) {
  const base = f.split("/").pop();
  cpSync(f, `${outdir}/${base}`);
}

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  format: "iife",
  target: "chrome111",
  sourcemap: true,
  logLevel: "info",
};

const entries = [
  // Isolated-world content script: holds the socket, DOM overlays, bridges to page.
  { in: "src/content.ts", out: "content" },
  // Main-world content script: talks to netflix.* player API.
  { in: "src/inject.ts", out: "inject" },
  { in: "src/background.ts", out: "background" },
  { in: "src/popup.ts", out: "popup" },
];

const configs = entries.map((e) => ({
  ...common,
  entryPoints: [e.in],
  outfile: `${outdir}/${e.out}.js`,
}));

if (watch) {
  for (const c of configs) {
    const ctx = await context(c);
    await ctx.watch();
  }
  console.log("watching…");
} else {
  await Promise.all(configs.map((c) => build(c)));
  console.log("built extension -> dist/");
}
