import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createCreateGatewayConnectorHandler } from "./create";
import { createDeleteGatewayConnectorHandler } from "./delete";
import { createGetGatewayConnectorHandler } from "./get";
import { createListGatewayConnectorsHandler } from "./list";
import { createUpdateGatewayConnectorHandler } from "./update";

export function createGatewayConnectorHandler(
  core: Core,
  io: AppIO,
  imperativeMutationCommands = false,
): Router {
  const router = new Router("connector", "manage connectors configured for an AgentCore Gateway")
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list");
  if (imperativeMutationCommands) {
    router
      .handler(createCreateGatewayConnectorHandler(core, io))
      .handler(createUpdateGatewayConnectorHandler(core, io));
  }
  router
    .handler(createGetGatewayConnectorHandler(core))
    .handler(createListGatewayConnectorsHandler(core));
  if (imperativeMutationCommands) router.handler(createDeleteGatewayConnectorHandler(core));
  return router;
}
