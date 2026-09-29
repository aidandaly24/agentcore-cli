import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import { FormRadioGroup } from "../../../../components/FormRadioGroup";
import { FormTextInput } from "../../../../components/FormTextInput";
import { darkTheme } from "../../../../components/ui/_core.js";
import {
  ChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  firstIssue,
  useKeyHints,
  useWizard,
  type Choice,
} from "../../../../components/wizard";
import { OidcDiscoveryUrlSchema } from "../../../../projectSchemas/auth";
import {
  DEFAULT_AUTO_PAYMENT,
  DEFAULT_SPEND_LIMIT,
  PaymentManagerNameSchema,
  PaymentSpendLimitSchema,
  type PaymentAuthorizerType,
} from "../../../../projectSchemas/payment";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import { ProjectGate, projectQueryKey } from "../../ProjectGate";
import type { Project } from "../../types";
import { toAddPaymentManagerInput } from "./index";

const BREADCRUMB = ["agentcore", "add", "payment-manager"];
const DESCRIPTION = "add a payment manager to the current project";
const ADD_MENU = "/agentcore/add";

const AUTHORIZER_CHOICES: Choice<PaymentAuthorizerType>[] = [
  { value: "AWS_IAM", label: "AWS_IAM (default)", description: "require SigV4-signed requests" },
  {
    value: "CUSTOM_JWT",
    label: "CUSTOM_JWT",
    description: "validate tokens from your OIDC provider",
  },
];

const AUTO_PAYMENT_CHOICES: Choice<boolean>[] = [
  {
    value: true,
    label: "on (default)",
    description: "agents can settle 402 responses without human approval",
  },
  { value: false, label: "off", description: "require manual approval for payments" },
];

type PaymentManagerFormValues = {
  name: string;
  authorizerType: PaymentAuthorizerType;
  discoveryUrl: string;
  allowedClients: string;
  autoPayment: boolean;
  defaultSpendLimit: string;
};

function splitClients(value: string): string[] {
  return value
    .split(",")
    .map((client) => client.trim())
    .filter(Boolean);
}

export function AddPaymentManagerScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(ADD_MENU)}
    >
      {(project) => <AddPaymentManagerWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddPaymentManagerWizard({
  project,
  core,
}: {
  project: Project;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<PaymentManagerFormValues>({
    name: "",
    authorizerType: "AWS_IAM",
    discoveryUrl: "",
    allowedClients: "",
    autoPayment: DEFAULT_AUTO_PAYMENT,
    defaultSpendLimit: DEFAULT_SPEND_LIMIT,
  });
  const set = (update: Partial<PaymentManagerFormValues>) =>
    setValues((current) => ({ ...current, ...update }));
  const isJwt = values.authorizerType === "CUSTOM_JWT";

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddPaymentManagerInput({
            name: values.name,
            authorizerType: values.authorizerType,
            authorizerConfiguration: isJwt
              ? {
                  customJWTAuthorizer: {
                    discoveryUrl: values.discoveryUrl.trim(),
                    allowedClients: splitClients(values.allowedClients),
                  },
                }
              : undefined,
            autoPayment: values.autoPayment,
            defaultSpendLimit: values.defaultSpendLimit,
          }),
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding payment manager ${values.name}...`}
      successLabel={`added payment manager '${values.name}' to '${project.name}'`}
      successHint={
        project.spec.runtimes.length > 0
          ? "Runtime source code is unchanged. Configure the Payments SDK or plugin before invoking payment-enabled agents."
          : undefined
      }
      successNextSteps={["agentcore add payment-connector --help", "agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this payment manager be called?">
        <TextField
          label="Payment manager name"
          help="letters and digits, starting with a letter; up to 48 characters"
          placeholder="payments"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={PaymentManagerNameSchema}
          live
        />
      </Step>

      <Step stepKey="authorizer" prompt="how should payment callers authenticate?">
        <AuthorizerField values={values} onChange={set} />
      </Step>

      <Step stepKey="auto-payment" prompt="allow automatic payments?">
        <ChoiceField
          choices={AUTO_PAYMENT_CHOICES}
          value={values.autoPayment}
          onChange={(autoPayment) => set({ autoPayment })}
        />
      </Step>

      <Step stepKey="spend-limit" prompt="what is the default payment-session spend limit?">
        <TextField
          label="Default spend limit"
          value={values.defaultSpendLimit}
          onChange={(defaultSpendLimit) => set({ defaultSpendLimit })}
          required
          schema={PaymentSpendLimitSchema}
        />
      </Step>

      <Step stepKey="review" prompt="this payment manager will be added to agentcore.json">
        <Summary
          items={{
            manager: values.name,
            authorizer: values.authorizerType,
            ...(isJwt
              ? {
                  issuer: values.discoveryUrl.trim(),
                  "allowed clients": splitClients(values.allowedClients).join(", "),
                }
              : {}),
            "auto-payment": values.autoPayment ? "on (without human approval)" : "off",
            "default spend limit": values.defaultSpendLimit,
          }}
        />
      </Step>
    </Wizard>
  );
}

function AuthorizerField({
  values,
  onChange,
}: {
  values: PaymentManagerFormValues;
  onChange: (update: Partial<PaymentManagerFormValues>) => void;
}) {
  const { advance, back } = useWizard();
  const index = AUTHORIZER_CHOICES.findIndex((choice) => choice.value === values.authorizerType);
  const [focusedField, setFocusedField] = useState<number | null>(null);
  const [error, setError] = useState<string>();

  useKeyHints([
    { key: "\u2191\u2193", label: "navigate" },
    { key: "enter", label: "continue" },
  ]);

  useInput((_input, key) => {
    if (focusedField === null) {
      if (key.escape) {
        back();
      } else if (key.upArrow || key.downArrow) {
        const next = key.upArrow ? Math.max(0, index - 1) : Math.min(1, index + 1);
        onChange({ authorizerType: AUTHORIZER_CHOICES[next]!.value });
        setError(undefined);
      } else if (key.return) {
        if (values.authorizerType === "CUSTOM_JWT") setFocusedField(0);
        else advance();
      }
      return;
    }

    if (key.escape || (key.upArrow && focusedField === 0)) {
      setFocusedField(null);
      setError(undefined);
      return;
    }
    if (key.upArrow || key.downArrow) {
      setFocusedField(key.upArrow ? 0 : 1);
      setError(undefined);
      return;
    }
    if (!key.return) return;

    const issue = firstIssue(OidcDiscoveryUrlSchema, values.discoveryUrl.trim());
    if (issue !== undefined) {
      setFocusedField(0);
      setError(issue);
    } else if (focusedField === 0) {
      setFocusedField(1);
      setError(undefined);
    } else if (splitClients(values.allowedClients).length === 0) {
      setError("At least one OAuth client ID is required");
    } else {
      setError(undefined);
      advance();
    }
  });

  return (
    <Box flexDirection="column">
      <FormRadioGroup
        helpText=""
        options={AUTHORIZER_CHOICES.map(({ label, description }) => ({
          label,
          description: description ?? "",
        }))}
        focusedIndex={focusedField === null ? index : undefined}
        selectedIndex={index}
      />
      {focusedField !== null && (
        <>
          <FormTextInput
            name="discovery URL"
            helpText="HTTPS URL ending in /.well-known/openid-configuration"
            placeholder="https://idp.example.com/.well-known/openid-configuration"
            errorText=""
            value={values.discoveryUrl}
            onChange={(discoveryUrl) => {
              onChange({ discoveryUrl });
              setError(undefined);
            }}
            focused={focusedField === 0}
          />
          <FormTextInput
            name="allowed clients"
            helpText="one or more OAuth client IDs, separated by commas"
            placeholder="agentcore-cli, internal-tools"
            errorText=""
            value={values.allowedClients}
            onChange={(allowedClients) => {
              onChange({ allowedClients });
              setError(undefined);
            }}
            focused={focusedField === 1}
          />
        </>
      )}
      {error !== undefined && <Text color={darkTheme.colors.error}>{error}</Text>}
    </Box>
  );
}
