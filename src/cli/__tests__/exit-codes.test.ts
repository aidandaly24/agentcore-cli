import { ExitCode, getExitCode } from '../exit-codes.js';
import { describe, expect, it } from 'vitest';

describe('exit-codes', () => {
  describe('ExitCode', () => {
    it('has correct values for all exit codes', () => {
      expect(ExitCode.SUCCESS).toBe(0);
      expect(ExitCode.GENERAL_ERROR).toBe(1);
      expect(ExitCode.INVALID_ARGS).toBe(2);
      expect(ExitCode.AUTH_EXPIRED).toBe(3);
      expect(ExitCode.ACCESS_DENIED).toBe(4);
      expect(ExitCode.AGENT_NOT_FOUND).toBe(5);
      expect(ExitCode.DEPLOY_FAILED).toBe(6);
    });

    it('has all expected keys', () => {
      const keys = Object.keys(ExitCode);
      expect(keys).toContain('SUCCESS');
      expect(keys).toContain('GENERAL_ERROR');
      expect(keys).toContain('INVALID_ARGS');
      expect(keys).toContain('AUTH_EXPIRED');
      expect(keys).toContain('ACCESS_DENIED');
      expect(keys).toContain('AGENT_NOT_FOUND');
      expect(keys).toContain('DEPLOY_FAILED');
      expect(keys).toHaveLength(7);
    });
  });

  describe('getExitCode', () => {
    describe('access denied errors → EXIT_ACCESS_DENIED (4)', () => {
      it('returns 4 for AccessDeniedException', () => {
        expect(getExitCode({ name: 'AccessDeniedException' })).toBe(ExitCode.ACCESS_DENIED);
      });

      it('returns 4 for AccessDenied', () => {
        expect(getExitCode({ name: 'AccessDenied' })).toBe(ExitCode.ACCESS_DENIED);
      });
    });

    describe('expired token errors → EXIT_AUTH_EXPIRED (3)', () => {
      const expiredTokenNames = [
        'ExpiredToken',
        'ExpiredTokenException',
        'TokenRefreshRequired',
        'CredentialsExpired',
        'InvalidIdentityToken',
        'UnauthorizedAccess',
        'InvalidClientTokenId',
        'SignatureDoesNotMatch',
        'RequestExpired',
      ];

      it('returns 3 for all expired token error names', () => {
        for (const name of expiredTokenNames) {
          expect(getExitCode({ name }), `Should return 3 for error.name: ${name}`).toBe(ExitCode.AUTH_EXPIRED);
        }
      });

      it('returns 3 for expired token error Code properties', () => {
        for (const Code of expiredTokenNames) {
          expect(getExitCode({ Code }), `Should return 3 for error.Code: ${Code}`).toBe(ExitCode.AUTH_EXPIRED);
        }
      });

      it('returns 3 for expired token message patterns', () => {
        const patterns = [
          'expired token',
          'token has expired',
          'credentials have expired',
          'security token included in the request is expired',
          'the security token included in the request is invalid',
        ];
        for (const pattern of patterns) {
          expect(getExitCode(new Error(pattern)), `Should return 3 for message: ${pattern}`).toBe(
            ExitCode.AUTH_EXPIRED
          );
        }
      });

      it('returns 3 for nested expired token errors', () => {
        expect(getExitCode({ cause: { name: 'ExpiredToken' } })).toBe(ExitCode.AUTH_EXPIRED);
      });
    });

    describe('no credentials errors → EXIT_AUTH_EXPIRED (3)', () => {
      it('returns 3 for AwsCredentialsError', () => {
        expect(getExitCode({ name: 'AwsCredentialsError' })).toBe(ExitCode.AUTH_EXPIRED);
      });

      it('returns 3 for no credentials message patterns', () => {
        const patterns = ['no aws credentials found', 'could not load credentials', 'credentials not found'];
        for (const pattern of patterns) {
          expect(getExitCode(new Error(pattern)), `Should return 3 for message: ${pattern}`).toBe(
            ExitCode.AUTH_EXPIRED
          );
        }
      });
    });

    describe('commander invalid argument errors → EXIT_INVALID_ARGS (2)', () => {
      it('returns 2 for commander.invalidArgument code', () => {
        const err = Object.assign(new Error('invalid argument'), { code: 'commander.invalidArgument' });
        expect(getExitCode(err)).toBe(ExitCode.INVALID_ARGS);
      });

      it('returns 2 for commander.missingArgument code', () => {
        const err = Object.assign(new Error('missing argument'), { code: 'commander.missingArgument' });
        expect(getExitCode(err)).toBe(ExitCode.INVALID_ARGS);
      });

      it('returns 2 for commander.missingMandatoryOptionValue code', () => {
        const err = Object.assign(new Error('missing option value'), {
          code: 'commander.missingMandatoryOptionValue',
        });
        expect(getExitCode(err)).toBe(ExitCode.INVALID_ARGS);
      });

      it('returns 2 for commander.optionMissingArgument code', () => {
        const err = Object.assign(new Error('option missing argument'), {
          code: 'commander.optionMissingArgument',
        });
        expect(getExitCode(err)).toBe(ExitCode.INVALID_ARGS);
      });
    });

    describe('deploy failed errors → EXIT_DEPLOY_FAILED (6)', () => {
      it('returns 6 for stack in progress errors', () => {
        const states = ['UPDATE_IN_PROGRESS', 'CREATE_IN_PROGRESS', 'DELETE_IN_PROGRESS', 'ROLLBACK_IN_PROGRESS'];
        for (const state of states) {
          expect(getExitCode(new Error(`Stack is in ${state} state`)), `Should return 6 for state: ${state}`).toBe(
            ExitCode.DEPLOY_FAILED
          );
        }
      });

      it('returns 6 for stack cannot be updated errors', () => {
        expect(getExitCode(new Error('Stack is in UPDATE_ROLLBACK_IN_PROGRESS state and cannot be updated'))).toBe(
          ExitCode.DEPLOY_FAILED
        );
      });

      it('returns 6 for stack currently being updated', () => {
        expect(getExitCode(new Error('stack is currently being updated'))).toBe(ExitCode.DEPLOY_FAILED);
      });

      it('returns 6 for changeset in progress errors', () => {
        expect(
          getExitCode(
            new Error('InvalidChangeSetStatusException: An operation on this ChangeSet is currently in progress.')
          )
        ).toBe(ExitCode.DEPLOY_FAILED);
      });

      it('returns 6 for changeset currently in progress', () => {
        expect(getExitCode(new Error('ChangeSet is currently in progress'))).toBe(ExitCode.DEPLOY_FAILED);
      });
    });

    describe('agent not found errors → EXIT_AGENT_NOT_FOUND (5)', () => {
      it('returns 5 for agent not found message', () => {
        expect(getExitCode(new Error("Agent 'my-agent' not found"))).toBe(ExitCode.AGENT_NOT_FOUND);
      });

      it('returns 5 for agent not deployed message', () => {
        expect(getExitCode(new Error("Agent 'my-agent' is not deployed"))).toBe(ExitCode.AGENT_NOT_FOUND);
      });

      it('returns 5 for no agents defined message', () => {
        expect(getExitCode(new Error('No agents defined in agentcore.json'))).toBe(ExitCode.AGENT_NOT_FOUND);
      });
    });

    describe('default → EXIT_GENERAL_ERROR (1)', () => {
      it('returns 1 for generic errors', () => {
        expect(getExitCode(new Error('some random error'))).toBe(ExitCode.GENERAL_ERROR);
      });

      it('returns 1 for null', () => {
        expect(getExitCode(null)).toBe(ExitCode.GENERAL_ERROR);
      });

      it('returns 1 for undefined', () => {
        expect(getExitCode(undefined)).toBe(ExitCode.GENERAL_ERROR);
      });

      it('returns 1 for string errors', () => {
        expect(getExitCode('string error')).toBe(ExitCode.GENERAL_ERROR);
      });

      it('returns 1 for empty objects', () => {
        expect(getExitCode({})).toBe(ExitCode.GENERAL_ERROR);
      });

      it('returns 1 for number errors', () => {
        expect(getExitCode(123)).toBe(ExitCode.GENERAL_ERROR);
      });
    });

    describe('priority ordering', () => {
      it('access denied takes priority over message-based matching', () => {
        const err = { name: 'AccessDeniedException', message: 'Agent not found' };
        expect(getExitCode(err)).toBe(ExitCode.ACCESS_DENIED);
      });

      it('expired token takes priority over agent not found message matching', () => {
        const err = { name: 'ExpiredToken', message: 'Agent not found' };
        expect(getExitCode(err)).toBe(ExitCode.AUTH_EXPIRED);
      });

      it('access denied takes priority over expired token', () => {
        expect(getExitCode({ name: 'AccessDeniedException' })).toBe(ExitCode.ACCESS_DENIED);
        expect(getExitCode({ name: 'AccessDenied' })).toBe(ExitCode.ACCESS_DENIED);
      });
    });
  });
});
