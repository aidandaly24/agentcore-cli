import { Box, Text } from "ink";
import type { ExecItem } from "../handlers/exec";
import { darkTheme } from "./ui/_core";

export function ExecOutput({ item, width }: { item: ExecItem; width: number }) {
  const { colors } = darkTheme;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colors.text}>$ </Text>
        <Box width={Math.max(1, width - 4)}>
          <Text color={colors.text}>{item.command}</Text>
        </Box>
      </Box>
      {item.output !== "" || item.status === "running" ? (
        <Box paddingLeft={2} width={Math.max(1, width - 2)}>
          <Text color={item.status === "error" ? colors.error : colors.muted}>
            {item.output.trimEnd()}
            {item.status === "running" ? "\u258c" : ""}
          </Text>
        </Box>
      ) : null}
      {item.status === "error" && item.exitCode !== undefined && item.exitCode !== 0 ? (
        <Box paddingLeft={2}>
          <Text color={colors.error}>exit {item.exitCode}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
