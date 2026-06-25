import { BootstrapEcrAccessDeniedError } from '../../../../lib';
import { CdkToolkitWrapper } from '../wrapper.js';
import { describe, expect, it } from 'vitest';

/**
 * Builds a wrapper with an injected fake toolkit whose `bootstrap` rejects,
 * exercising the real error-remap path in CdkToolkitWrapper.bootstrap().
 */
function wrapperRejectingWith(err: unknown): CdkToolkitWrapper {
  const wrapper = new CdkToolkitWrapper();
  const fakeToolkit = { bootstrap: () => Promise.reject(err) };
  Object.assign(wrapper as unknown as Record<string, unknown>, {
    toolkit: fakeToolkit,
    cloudAssemblySource: {},
  });
  return wrapper;
}

describe('CdkToolkitWrapper.bootstrap error remapping', () => {
  it('remaps an ecr:CreateRepository AccessDenied failure to an actionable error', async () => {
    const raw = new Error(
      'ECR Permission Denied - User is not authorized to perform: ecr:CreateRepository (AccessDenied)'
    );
    const wrapper = wrapperRejectingWith(raw);

    const error = await wrapper.bootstrap(['aws://123456789012/us-east-1']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BootstrapEcrAccessDeniedError);
    expect((error as Error).message).toContain('needed only by the shared CDK bootstrap stack');
    expect((error as Error).message).not.toContain('CDK bootstrap failed:');
    expect((error as { cause?: unknown }).cause).toBe(raw);
  });

  it('passes through unrelated bootstrap failures unchanged', async () => {
    const raw = new Error('Some other CloudFormation failure');
    const wrapper = wrapperRejectingWith(raw);

    const error = await wrapper.bootstrap(['aws://123456789012/us-east-1']).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(BootstrapEcrAccessDeniedError);
    expect((error as Error).message).toContain('Some other CloudFormation failure');
  });
});
