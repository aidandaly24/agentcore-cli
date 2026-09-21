import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createCreateGatewayRuleHandler } from "./create";
import { createDeleteGatewayRuleHandler } from "./delete";
import { createGetGatewayRuleHandler } from "./get";
import { createListGatewayRulesHandler } from "./list";
import { createUpdateGatewayRuleHandler } from "./update";

export function createGatewayRuleHandler(
  core: Core,
  io: AppIO,
  imperativeMutationCommands = false,
): Router {
  const router = new Router("rule", "manage Rules for an AgentCore Gateway")
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list");
  if (imperativeMutationCommands) {
    router
      .handler(createCreateGatewayRuleHandler(core, io))
      .handler(createUpdateGatewayRuleHandler(core, io));
  }
  router.handler(createGetGatewayRuleHandler(core)).handler(createListGatewayRulesHandler(core));
  if (imperativeMutationCommands) router.handler(createDeleteGatewayRuleHandler(core));
  return router;
}
