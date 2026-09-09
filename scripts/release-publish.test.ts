import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

interface Job {
  if?: string;
  needs?: string;
  "runs-on"?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  with?: Record<string, string>;
  env?: Record<string, string>;
  steps?: { id?: string; run?: string }[];
}

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../.github/workflows/release-publish.yml", import.meta.url)).text(),
) as { on: { push: { branches: string[] } }; jobs: Record<string, Job> };
const repository = "aws/agentcore-cli";
const sha = "0caec7fe932a0d4f8f8ce2d4821fee0664ab77cf";
const releasePr = {
  merged_at: "2026-09-04T22:18:03Z",
  merge_commit_sha: sha,
  head: { ref: "release/v1.0.0-rc.1", repo: { full_name: repository } },
  base: { ref: "refactor", repo: { full_name: repository } },
};

test("release runs only on target-branch pushes and verifies the exact commit before publishing", () => {
  expect(workflow.on).toEqual({ push: { branches: ["refactor"] } });
  const check = workflow.jobs["check-release"]!;
  expect(check.if).toBe("!github.event.deleted");
  expect(check["runs-on"]).toBe("ubuntu-latest");
  expect(check.permissions).toEqual({ "pull-requests": "read" });
  expect(check.outputs).toEqual({ is_release: "${{ steps.check.outputs.is_release }}" });
  expect(workflow.jobs.verify).toMatchObject({
    needs: "check-release",
    if: "needs.check-release.outputs.is_release == 'true'",
    with: { ref: "${{ github.sha }}" },
  });
  expect(workflow.jobs.publish).toMatchObject({
    needs: "verify",
    "runs-on": "ubuntu-latest",
    env: { REF: "${{ github.sha }}" },
  });
});

// The gate runs on Ubuntu; execute its actual shell script wherever bash and jq are available.
const shellTest = test.skipIf(
  process.platform === "win32" || !Bun.which("bash") || !Bun.which("jq"),
);

async function checkRelease(pages: unknown[][], apiExitCode = 0) {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-release-"));
  try {
    const gh = join(directory, "gh");
    await Bun.write(gh, '#!/bin/sh\nprintf "%s" "$PULL_REQUESTS"\nexit "$API_EXIT_CODE"\n');
    await chmod(gh, 0o755);
    const output = join(directory, "output");
    await Bun.write(output, "");
    const script = workflow.jobs["check-release"]!.steps!.find((step) => step.id === "check")!.run!;
    const check = Bun.spawn(["bash", "--noprofile", "--norc", "-c", script], {
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: repository,
        GITHUB_SHA: sha,
        GITHUB_REF_NAME: "refactor",
        GITHUB_OUTPUT: output,
        PULL_REQUESTS: JSON.stringify(pages),
        API_EXIT_CODE: String(apiExitCode),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      check.exited,
      new Response(check.stdout).text(),
      new Response(check.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, output: await Bun.file(output).text() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

shellTest("accepts the merged in-repository release PR, including later API pages", async () => {
  const result = await checkRelease([[{ ...releasePr, merged_at: null }], [releasePr]]);
  expect(result).toMatchObject({ exitCode: 0, output: "is_release=true\n" });
});

shellTest.each([
  ["ordinary PR", { ...releasePr, head: { ...releasePr.head, ref: "fix/something" } }],
  ["unmerged release PR", { ...releasePr, merged_at: null }],
  ["different commit", { ...releasePr, merge_commit_sha: "another-commit" }],
  [
    "fork release PR",
    { ...releasePr, head: { ...releasePr.head, repo: { full_name: "someone/agentcore-cli" } } },
  ],
  ["deleted fork", { ...releasePr, head: { ...releasePr.head, repo: null } }],
  ["different target branch", { ...releasePr, base: { ...releasePr.base, ref: "main" } }],
  [
    "different target repository",
    { ...releasePr, base: { ...releasePr.base, repo: { full_name: "someone/agentcore-cli" } } },
  ],
])("skips %s", async (_name, pr) => {
  const result = await checkRelease([[pr]]);
  expect(result).toMatchObject({ exitCode: 0, output: "is_release=false\n" });
});

shellTest("skips pushes without an associated PR", async () => {
  const result = await checkRelease([[]]);
  expect(result).toMatchObject({ exitCode: 0, output: "is_release=false\n" });
});

shellTest("fails closed on a GitHub API error", async () => {
  const result = await checkRelease([[releasePr]], 1);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toBe("");
});
