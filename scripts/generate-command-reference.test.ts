import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GENERATOR = join(import.meta.dir, "generate-command-reference.mjs");
const CLI_FIXTURE = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
appendFileSync(process.env.REFERENCE_TRACE, JSON.stringify({
  home, profile: process.env.USERPROFILE,
}) + "\\n");
if (process.env.FAIL_HELP === "1") {
  console.error("intentional help failure");
  process.exit(2);
}
const configPath = join(home, ".agentcore", "config.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const path = process.argv.slice(2, -1).join(" ");
const tree = {
  "": ["project", "harness", "identity", "runtime", "memory", "gateway", "payment", "eval", "feedback", "config", "update"],
  "project": ["add"],
  "project add": ["gateway"],
  "gateway": ["get", "list", "invoke", "target", "connector", "rule", "policy"],
  "gateway target": ["get", "list"],
  "gateway connector": ["get", "list"],
  "gateway rule": ["get", "list"],
  "gateway policy": ["generate"],
};
const commands = tree[path] ?? [];
if (config["imperative-mutation-commands"] &&
    ["gateway", "gateway target", "gateway connector", "gateway rule"].includes(path)) {
  commands.push("create", "update", "delete");
}
console.log("Usage: agentcore" + (path ? " " + path : "") +
  (commands.length ? " [command]" : "") + "\\n\\nFixture command\\n" +
  (commands.length ? "\\nCommands:\\n" +
    commands.map((name) => "  " + name + "  fixture command").join("\\n") : ""));
`;

describe("command reference generation", () => {
  let directory: string;
  let callerHome: string;
  let configPath: string;
  let cliPath: string;
  let outputPath: string;
  let tracePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentcore-reference-test-"));
    callerHome = join(directory, "caller home");
    configPath = join(callerHome, ".agentcore", "config.json");
    cliPath = join(directory, "cli.mjs");
    outputPath = join(directory, "command.md");
    tracePath = join(directory, "trace.jsonl");
    await mkdir(join(callerHome, ".agentcore"), { recursive: true });
    await writeFile(cliPath, CLI_FIXTURE);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function generate(failHelp = false) {
    return Bun.spawnSync({
      cmd: [process.execPath, GENERATOR, "--out", outputPath],
      env: {
        ...process.env,
        HOME: callerHome,
        USERPROFILE: callerHome,
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
        AGENTCORE_BIN: `${process.execPath} ${cliPath}`,
        REFERENCE_TRACE: tracePath,
        FAIL_HELP: failHelp ? "1" : "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  async function expectIsolatedHomeRemoved() {
    const trace = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { home: string; profile: string });
    expect(trace.length).toBeGreaterThan(0);
    expect(new Set(trace.map(({ home }) => home)).size).toBe(1);
    for (const { home, profile } of trace) {
      expect(home).not.toBe(callerHome);
      expect(profile).toBe(home);
      expect(existsSync(home)).toBe(false);
    }
  }

  test.each([false, true])(
    "documents default commands without changing a caller's opt-in value of %s",
    async (enabled) => {
      const config = JSON.stringify({ "imperative-mutation-commands": enabled });
      await writeFile(configPath, config);

      const result = generate();
      expect(result.exitCode).toBe(0);
      const reference = await readFile(outputPath, "utf8");
      for (const group of ["gateway", "gateway target", "gateway connector", "gateway rule"]) {
        for (const mutation of ["create", "update", "delete"]) {
          expect(reference).not.toContain(`agentcore ${group} ${mutation}`);
        }
        expect(reference).toContain(`agentcore ${group} get`);
        expect(reference).toContain(`agentcore ${group} list`);
      }
      expect(reference).toContain("agentcore gateway invoke");
      expect(reference).toContain("agentcore gateway policy generate");
      expect(reference).toContain("agentcore project add gateway");
      expect(reference).not.toContain("imperative-mutation-commands");
      expect(await readFile(configPath, "utf8")).toBe(config);
      await expectIsolatedHomeRemoved();
    },
  );

  test("does not load a malformed caller config", async () => {
    await writeFile(configPath, "not json");
    expect(generate().exitCode).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe("not json");
    await expectIsolatedHomeRemoved();
  });

  test("cleans up its temporary home when help generation fails", async () => {
    const result = generate(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("intentional help failure");
    expect(existsSync(outputPath)).toBe(false);
    await expectIsolatedHomeRemoved();
  });
});
