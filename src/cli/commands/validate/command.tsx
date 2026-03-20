import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { handleValidate } from './action';
import type { Command } from '@commander-js/extra-typings';
import { Box, Text, render } from 'ink';

export const registerValidate = (program: Command) => {
  program
    .command('validate')
    .option('-d, --directory <path>', 'Project directory containing agentcore config')
    .description(COMMAND_DESCRIPTIONS.validate)
    .action(async options => {
      const result = await handleValidate(options);

      if (result.success) {
        render(<Text color="green">Valid</Text>);
        process.exit(0);
      } else {
        render(
          <Box flexDirection="column">
            {result.results
              .filter(r => !r.success)
              .map(r => (
                <Text key={r.file} color="red">
                  {r.error}
                </Text>
              ))}
            {result.results.length === 0 && result.error && <Text color="red">{result.error}</Text>}
          </Box>
        );
        process.exit(1);
      }
    });
};
