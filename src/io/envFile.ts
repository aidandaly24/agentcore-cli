import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { InputValidationError } from "../errors";
import { LocalSecrets } from "./localSecrets";

type ReadEnvFileConfig = {
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  secrets?: LocalSecrets;
};

export async function readEnvFile(
  path: string,
  config: ReadEnvFileConfig = {},
): Promise<Record<string, string>> {
  let contents: string;
  try {
    contents = await (config.readFile ?? readFile)(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new InputValidationError(`Unable to read local environment file at ${path}`, {
      cause: error,
    });
  }

  let env: Record<string, string>;
  try {
    env = parseEnv(contents) as Record<string, string>;
  } catch (error) {
    throw new InputValidationError(`Invalid local environment file at ${path}`, { cause: error });
  }
  return (config.secrets ?? new LocalSecrets()).decrypt(env);
}
