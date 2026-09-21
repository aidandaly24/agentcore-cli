import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createCreateGatewayTargetHandler } from "./create";
import { createDeleteGatewayTargetHandler } from "./delete";
import { createGetGatewayTargetHandler } from "./get";
import { createListGatewayTargetsHandler } from "./list";
import { createUpdateGatewayTargetHandler } from "./update";

export function createGatewayTargetHandler(
  core: Core,
  io: AppIO,
  imperativeMutationCommands = false,
): Router {
  const router = new Router("target", "manage Targets for an AgentCore Gateway")
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list");
  if (imperativeMutationCommands) {
    router
      .handler(createCreateGatewayTargetHandler(core, io))
      .handler(createUpdateGatewayTargetHandler(core, io));
  }
  router
    .handler(createGetGatewayTargetHandler(core))
    .handler(createListGatewayTargetsHandler(core));
  if (imperativeMutationCommands) router.handler(createDeleteGatewayTargetHandler(core));
  return router;
}
