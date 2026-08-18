import type { TargetConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { parseJsonObjectFlag } from "../../../utils";
import type { AddProjectResourceConfig } from "../types";
import {
  connectorTargetFromShortcut,
  translateTargetConfiguration,
} from "../gateway-target/configuration";

export const createAddGatewayConnectorHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "gateway-connector",
    description: "adds a connector-backed Target to a project Gateway",
    flags: [
      flag("gateway", "name of the parent Gateway in this project", z.string().optional()),
      flag("name", "the connector Target name", z.string().optional()),
      flag(
        "connector",
        "curated connector",
        z.enum(["web-search", "bedrock-knowledge-bases"]).optional(),
      ),
      flag(
        "connector-configuration",
        "connector-backed Target configuration (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "knowledge-base",
        "project Knowledge Base name or external ten-character Knowledge Base ID",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags.gateway) {
        throw new InputValidationError("required option '--gateway <gateway>' not specified");
      }
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if ((flags.connector === undefined) === (flags["connector-configuration"] === undefined)) {
        throw new InputValidationError(
          "specify exactly one of '--connector' or '--connector-configuration'",
        );
      }
      if (flags["knowledge-base"] !== undefined && flags.connector !== "bedrock-knowledge-bases") {
        throw new InputValidationError(
          "--knowledge-base requires --connector bedrock-knowledge-bases",
        );
      }

      const project = ctx.require(ProjectKey);
      let target;
      if (flags.connector) {
        target = connectorTargetFromShortcut(flags.name, flags.connector, flags["knowledge-base"]);
      } else {
        const source = new SourceResolver({ stdin: config.io.stdin });
        const connectorConfiguration = parseJsonObjectFlag<TargetConfiguration>(
          "connector-configuration",
          await source.resolveText("connector-configuration", flags["connector-configuration"]),
        )!;
        const translated = translateTargetConfiguration(flags.name, connectorConfiguration);
        if (translated.target.targetType !== "connector") {
          throw new InputValidationError(
            "--connector-configuration must contain an MCP connector Target",
          );
        }
        target = translated.target;
      }

      for await (const event of config.projectManager.addResource(project, {
        resourceType: "gateway-target",
        gatewayName: flags.gateway,
        resourceConfig: target,
      })) {
        config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(
        `added Connector Target '${flags.name}' to Gateway '${flags.gateway}' in '${project.name}'\n`,
      );
    },
  });
