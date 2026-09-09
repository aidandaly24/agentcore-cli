import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../package.json";

test("npm tarball includes only the Node bundle and runtime assets, even after compilation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-package-"));
  try {
    const included = [
      "README.md",
      "LICENSE",
      "dist/index.js",
      "dist/main.js",
      "dist/assets/cdk/package.json",
      "dist/assets/cdk/.prettierrc",
      "dist/assets/agent-inspector/index.html.asset",
    ];
    const excluded = [
      "dist/bin/agentcore-linux-x64",
      "dist/bin/agentcore-windows-x64.exe",
      "dist/main.js.map",
      "dist/debug.log",
      "dist/old-build/index.js",
      "src/index.ts",
      "scripts/build.ts",
      ".github/workflows/release-publish.yml",
    ];
    await Bun.write(join(directory, "package.json"), JSON.stringify(manifest));
    for (const file of [...included, ...excluded]) {
      await Bun.write(join(directory, file), "fixture\n");
    }

    const tarball = join(directory, "package.tgz");
    const pack = Bun.spawn(
      [process.execPath, "pm", "pack", "--ignore-scripts", "--filename", tarball],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      pack.exited,
      new Response(pack.stdout).text(),
      new Response(pack.stderr).text(),
    ]);
    expect({ exitCode, output: exitCode ? stdout + stderr : "" }).toEqual({
      exitCode: 0,
      output: "",
    });

    const files = await new Bun.Archive(await Bun.file(tarball).bytes()).files();
    expect([...files.keys()].sort()).toEqual(
      ["package.json", ...included].map((file) => `package/${file}`).sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
