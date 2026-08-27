import z from "zod";
import { InputValidationError } from "../../../../errors";
import type { PaymentCredential } from "../../../../projectSchemas/credential";
import { PaymentProviderSchema } from "../../../../projectSchemas/payment";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import {
  hasPaymentCredentialInput,
  paymentCredentialInputFlags,
  resolvePaymentCredentialEnvEntries,
} from "../credentials/payment/input";

export const createAddPaymentConnectorHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "payment-connector",
    description: "adds a connector to a project payment manager",
    flags: [
      flag("manager", "the parent payment manager", z.string().optional()),
      flag("name", "the payment connector name", z.string().optional()),
      flag("credential", "an existing payment credential to reuse", z.string().optional()),
      flag(
        "create-credential",
        "a new payment credential to create with the connector",
        z.string().optional(),
      ),
      flag(
        "provider",
        "provider for a newly created payment credential",
        PaymentProviderSchema.optional(),
      ),
      flag("quick-create", "create a CoinbaseCDP connector through Quick Create", z.boolean()),
      ...paymentCredentialInputFlags,
    ],
    handle: async (ctx, flags) => {
      if (!flags.manager) {
        throw new InputValidationError("required option '--manager <manager>' not specified");
      }
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      const modes = [
        flags.credential !== undefined,
        flags["create-credential"] !== undefined,
        flags["quick-create"],
      ].filter(Boolean);
      if (modes.length !== 1) {
        throw new InputValidationError(
          "specify exactly one of '--credential', '--create-credential', or '--quick-create'",
        );
      }
      if (flags["create-credential"] && !flags.provider) {
        throw new InputValidationError("--create-credential requires --provider");
      }
      if (!flags["create-credential"] && (flags.provider || hasPaymentCredentialInput(flags))) {
        throw new InputValidationError(
          "--provider and payment credential options are valid only with --create-credential",
        );
      }

      const project = ctx.require(ProjectKey);
      let credentialConfig: PaymentCredential | undefined;
      let envEntries;
      let provider: PaymentCredential["provider"];
      let credentialName: string | undefined;

      if (flags["quick-create"]) {
        provider = "CoinbaseCDP";
      } else if (flags["create-credential"]) {
        provider = flags.provider!;
        credentialName = flags["create-credential"];
        credentialConfig = {
          authorizerType: "PaymentCredentialProvider",
          name: credentialName,
          provider,
        };
        envEntries = await resolvePaymentCredentialEnvEntries({
          name: credentialName,
          provider,
          flags,
          io: config.io,
        });
      } else {
        credentialName = flags.credential!;
        const credential = project.spec.credentials.find(
          (candidate) => candidate.name === credentialName,
        );
        if (!credential) {
          throw new InputValidationError(
            `credential '${credentialName}' does not exist in credentials[]`,
          );
        }
        if (credential.authorizerType !== "PaymentCredentialProvider") {
          throw new InputValidationError(
            `credential '${credentialName}' is a ${credential.authorizerType}, not a PaymentCredentialProvider`,
          );
        }
        provider = credential.provider;
      }

      for await (const event of config.projectManager.addResource(project, {
        resourceType: "payment-connector",
        managerName: flags.manager,
        resourceConfig: flags["quick-create"]
          ? {
              name: flags.name,
              provider: "CoinbaseCDP",
              provisionMode: "QUICK_CREATE",
            }
          : {
              name: flags.name,
              provider,
              credentialName: credentialName!,
            },
        credentialConfig,
        envEntries,
      })) {
        config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(
        `added payment connector '${flags.name}' to manager '${flags.manager}' in '${project.name}'\n`,
      );
    },
  });
