import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupScreens,
  flatFrame,
  renderScreen,
  waitForFlatText,
  waitForText,
  type RenderScreenResult,
} from "../../../../testing";
import { createPaymentProjectTestHarness } from "../payment-test-support";

const PATH = "/agentcore/add/payment-manager";
const DISCOVERY_URL = "https://idp.example.com/.well-known/openid-configuration";
const { cleanup, inProject, projectSpec, run } = createPaymentProjectTestHarness(
  "add-payment-manager-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

async function erase(screen: RenderScreenResult, value: string) {
  for (const _ of value) await screen.write("\u007f");
}

async function nameManager(screen: RenderScreenResult, name = "payments") {
  await waitForText(screen.lastFrame, "what should this payment manager be called?");
  await screen.write(name);
  await screen.press("return");
  await waitForText(screen.lastFrame, "how should payment callers authenticate?");
}

async function reviewDefaults(screen: RenderScreenResult) {
  await screen.press("return");
  await waitForText(screen.lastFrame, "allow automatic payments?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "what is the default payment-session spend limit?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "this payment manager will be added to agentcore.json");
}

describe("project add payment-manager wizard", () => {
  test("reviews and saves the same defaults as the flags, then returns to the menu", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen(PATH);
    await nameManager(screen);
    await reviewDefaults(screen);

    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("authorizer AWS_IAM");
    expect(review).toContain("auto-payment on (without human approval)");
    expect(review).toContain("default spend limit 10.00");
    expect((await projectSpec(projectRoot)).payments ?? []).toEqual([]);
    await screen.press("return");
    await waitForText(screen.lastFrame, "added payment manager 'payments'");
    await waitForFlatText(screen.lastFrame, "Runtime source code is unchanged");
    await screen.press("return");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();

    await run(["add", "payment-manager", "--name", "flagged"]);
    const [interactive, flagged] = (await projectSpec(projectRoot)).payments;
    expect(interactive).toEqual({ ...flagged, name: "payments" });
  });

  test("validates JWT inputs in place and saves manual payments with a decimal limit", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen(PATH);
    await nameManager(screen);
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "discovery URL");
    expect(screen.lastFrame()).toContain("how should payment callers authenticate?");

    await screen.write("http://idp.example.com");
    await screen.press("return");
    await waitForText(screen.lastFrame, "OIDC discovery URL must use HTTPS");
    await erase(screen, "http://idp.example.com");
    await screen.write(DISCOVERY_URL);
    await screen.press("return");
    await screen.press("return");
    await waitForText(screen.lastFrame, "At least one OAuth client ID is required");
    await screen.write("client-a, client-b");
    await screen.press("return");

    await waitForText(screen.lastFrame, "allow automatic payments?");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "what is the default payment-session spend limit?");
    await erase(screen, "10.00");
    await screen.write("25.50");
    await screen.press("return");
    await waitForText(screen.lastFrame, "this payment manager will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("auto-payment off");
    await screen.press("return");
    await waitForText(screen.lastFrame, "added payment manager 'payments'");

    expect((await projectSpec(projectRoot)).payments[0]).toEqual({
      name: "payments",
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJWTAuthorizer: {
          discoveryUrl: DISCOVERY_URL,
          allowedClients: ["client-a", "client-b"],
        },
      },
      connectors: [],
      autoPayment: false,
      defaultSpendLimit: "25.50",
    });
    screen.unmount();
  });

  test("back preserves answers and switching to IAM omits the JWT configuration", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen(PATH);
    await nameManager(screen);
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "discovery URL");
    await screen.write(DISCOVERY_URL);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "CUSTOM_JWT");
    expect(screen.lastFrame()).not.toContain("discovery URL");
    await screen.press("return");
    await waitForText(screen.lastFrame, DISCOVERY_URL);
    await screen.press("up");
    await screen.press("up");
    await reviewDefaults(screen);

    expect(flatFrame(screen.lastFrame)).toContain("authorizer AWS_IAM");
    expect(screen.lastFrame()).not.toContain(DISCOVERY_URL);
    await screen.press("return");
    await waitForText(screen.lastFrame, "added payment manager 'payments'");
    expect((await projectSpec(projectRoot)).payments[0].authorizerConfiguration).toBeUndefined();
    screen.unmount();
  });

  test("invalid names and spend limits stay on their field and can be corrected", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen(PATH);
    await waitForText(screen.lastFrame, "what should this payment manager be called?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Payment manager name is required");
    await screen.write("bad-name");
    await waitForText(screen.lastFrame, "alphanumeric");
    await erase(screen, "bad-name");
    await screen.write("payments");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should payment callers authenticate?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "allow automatic payments?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "what is the default payment-session spend limit?");
    await erase(screen, "10.00");
    await screen.write("-1");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Default spend limit must be a non-negative number");
    await erase(screen, "-1");
    await screen.write("0");
    await screen.press("return");
    await waitForText(screen.lastFrame, "this payment manager will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("default spend limit 0");
    expect((await projectSpec(projectRoot)).payments ?? []).toEqual([]);
    screen.unmount();
  });

  test("a duplicate reports the failure and returns to the review without losing answers", async () => {
    const projectRoot = await inProject();
    await run(["add", "payment-manager", "--name", "payments"]);
    const screen = renderScreen(PATH);
    await nameManager(screen);
    await reviewDefaults(screen);
    await screen.press("return");
    await waitForText(screen.lastFrame, "already exists");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this payment manager will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("manager payments");
    expect((await projectSpec(projectRoot)).payments).toHaveLength(1);
    screen.unmount();
  });

  test("esc from the first step cancels without adding a manager", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen(PATH);
    await waitForText(screen.lastFrame, "what should this payment manager be called?");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "add project resources");
    expect((await projectSpec(projectRoot)).payments ?? []).toEqual([]);
    screen.unmount();
  });
});
