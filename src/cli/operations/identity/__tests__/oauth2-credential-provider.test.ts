import {
  createOAuth2Provider,
  getOAuth2Provider,
  oAuth2ProviderExists,
  updateOAuth2Provider,
} from '../oauth2-credential-provider.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockSend, MockResourceNotFoundException } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  MockResourceNotFoundException: class extends Error {
    constructor(message = 'not found') {
      super(message);
      this.name = 'ResourceNotFoundException';
    }
  },
}));

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class {
    send = mockSend;
  },
  CreateOauth2CredentialProviderCommand: class {
    constructor(public input: unknown) {}
  },
  GetOauth2CredentialProviderCommand: class {
    constructor(public input: unknown) {}
  },
  UpdateOauth2CredentialProviderCommand: class {
    constructor(public input: unknown) {}
  },
  ResourceNotFoundException: MockResourceNotFoundException,
}));

function makeMockClient() {
  return { send: mockSend } as any;
}

describe('oAuth2ProviderExists', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns true when provider exists', async () => {
    mockSend.mockResolvedValue({});

    expect(await oAuth2ProviderExists(makeMockClient(), 'my-provider')).toBe(true);
  });

  it('returns false on ResourceNotFoundException', async () => {
    mockSend.mockRejectedValue(new MockResourceNotFoundException());

    expect(await oAuth2ProviderExists(makeMockClient(), 'my-provider')).toBe(false);
  });

  it('rethrows other errors', async () => {
    mockSend.mockRejectedValue(new Error('other error'));

    await expect(oAuth2ProviderExists(makeMockClient(), 'my-provider')).rejects.toThrow('other error');
  });
});

describe('createOAuth2Provider', () => {
  afterEach(() => vi.clearAllMocks());

  const mockParams = {
    name: 'test-provider',
    vendor: 'CustomOauth2',
    discoveryUrl: 'https://example.com/.well-known/openid_configuration',
    clientId: 'client123',
    clientSecret: 'secret123',
  };

  it('returns success with full result', async () => {
    const mockResponse = {
      credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/test-provider',
      clientSecretArn: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret' },
      callbackUrl: 'https://callback.example.com',
    };
    mockSend.mockResolvedValue(mockResponse);

    const result = await createOAuth2Provider(makeMockClient(), mockParams);

    expect(result).toEqual({
      success: true,
      result: {
        credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/test-provider',
        clientSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret',
        callbackUrl: 'https://callback.example.com',
      },
    });
  });

  it('falls back to update on ConflictException', async () => {
    const conflictError = new Error('conflict');
    Object.defineProperty(conflictError, 'name', { value: 'ConflictException' });

    const updateResponse = {
      credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/test-provider',
    };

    mockSend.mockRejectedValueOnce(conflictError);
    mockSend.mockResolvedValueOnce(updateResponse);

    const result = await createOAuth2Provider(makeMockClient(), mockParams);

    expect(result).toEqual({
      success: true,
      result: {
        credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/test-provider',
      },
    });
  });

  it('falls back to update on ResourceAlreadyExistsException', async () => {
    const existsError = new Error('already exists');
    Object.defineProperty(existsError, 'name', { value: 'ResourceAlreadyExistsException' });

    const updateResponse = {
      credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/test-provider',
    };

    mockSend.mockRejectedValueOnce(existsError);
    mockSend.mockResolvedValueOnce(updateResponse);

    const result = await createOAuth2Provider(makeMockClient(), mockParams);

    expect(result).toEqual({
      success: true,
      result: {
        credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/test-provider',
      },
    });
  });

  it('returns error on other exceptions', async () => {
    mockSend.mockRejectedValue(new Error('unexpected error'));

    const result = await createOAuth2Provider(makeMockClient(), mockParams);

    expect(result.success).toBe(false);
    expect(result.error).toBe('unexpected error');
  });

  it('returns error when no credentialProviderArn in response', async () => {
    mockSend.mockResolvedValue({});

    const result = await createOAuth2Provider(makeMockClient(), mockParams);

    expect(result).toEqual({
      success: false,
      error: 'No credential provider ARN in response',
    });
  });
});

describe('getOAuth2Provider', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns success with result', async () => {
    const mockResponse = {
      credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/test-provider',
      clientSecretArn: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret' },
      callbackUrl: 'https://callback.example.com',
    };
    mockSend.mockResolvedValue(mockResponse);

    const result = await getOAuth2Provider(makeMockClient(), 'test-provider');

    expect(result).toEqual({
      success: true,
      result: {
        credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/test-provider',
        clientSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret',
        callbackUrl: 'https://callback.example.com',
      },
    });
  });

  it('returns error on failure', async () => {
    mockSend.mockRejectedValue(new Error('get failed'));

    const result = await getOAuth2Provider(makeMockClient(), 'test-provider');

    expect(result.success).toBe(false);
    expect(result.error).toBe('get failed');
  });

  it('returns error when no ARN', async () => {
    mockSend.mockResolvedValue({});

    const result = await getOAuth2Provider(makeMockClient(), 'test-provider');

    expect(result).toEqual({
      success: false,
      error: 'No credential provider ARN in response',
    });
  });
});

describe('updateOAuth2Provider', () => {
  afterEach(() => vi.clearAllMocks());

  const mockParams = {
    name: 'test-provider',
    vendor: 'CustomOauth2',
    discoveryUrl: 'https://example.com/.well-known/openid_configuration',
    clientId: 'client123',
    clientSecret: 'secret123',
  };

  it('returns success with result', async () => {
    const mockResponse = {
      credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/test-provider',
      clientSecretArn: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret' },
    };
    mockSend.mockResolvedValue(mockResponse);

    const result = await updateOAuth2Provider(makeMockClient(), mockParams);

    expect(result).toEqual({
      success: true,
      result: {
        credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/test-provider',
        clientSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret',
      },
    });
  });

  it('returns error on failure', async () => {
    mockSend.mockRejectedValue(new Error('update failed'));

    const result = await updateOAuth2Provider(makeMockClient(), mockParams);

    expect(result.success).toBe(false);
    expect(result.error).toBe('update failed');
  });
});

describe('buildOAuth2Config routing (via createOAuth2Provider)', () => {
  afterEach(() => vi.clearAllMocks());

  it('named vendor (Google): routes to googleOauth2ProviderConfig', async () => {
    mockSend.mockResolvedValue({ credentialProviderArn: 'arn:test' });

    await createOAuth2Provider(makeMockClient(), {
      name: 'test',
      vendor: 'GoogleOauth2',
      clientId: 'cid',
      clientSecret: 'csec',
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion: mockSend was called
    const sentInput = mockSend.mock.calls[0]![0].input;
    expect(sentInput.credentialProviderVendor).toBe('GoogleOauth2');
    expect(sentInput.oauth2ProviderConfigInput.googleOauth2ProviderConfig.clientId).toBe('cid');
    expect(sentInput.oauth2ProviderConfigInput.googleOauth2ProviderConfig.clientSecret).toBe('csec');
  });

  it('named vendor with tenantId (Microsoft): includes tenantId in microsoftOauth2ProviderConfig', async () => {
    mockSend.mockResolvedValue({ credentialProviderArn: 'arn:test' });

    await createOAuth2Provider(makeMockClient(), {
      name: 'ms',
      vendor: 'MicrosoftOauth2',
      clientId: 'cid',
      clientSecret: 'csec',
      tenantId: 'tenant-123',
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const sentInput = mockSend.mock.calls[0]![0].input;
    expect(sentInput.credentialProviderVendor).toBe('MicrosoftOauth2');
    expect(sentInput.oauth2ProviderConfigInput.microsoftOauth2ProviderConfig.tenantId).toBe('tenant-123');
  });

  it('named vendor without tenantId (Microsoft): omits tenantId from microsoftOauth2ProviderConfig', async () => {
    mockSend.mockResolvedValue({ credentialProviderArn: 'arn:test' });

    await createOAuth2Provider(makeMockClient(), {
      name: 'ms',
      vendor: 'MicrosoftOauth2',
      clientId: 'cid',
      clientSecret: 'csec',
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const sentInput = mockSend.mock.calls[0]![0].input;
    expect(sentInput.oauth2ProviderConfigInput.microsoftOauth2ProviderConfig).not.toHaveProperty('tenantId');
  });

  it('included vendor (Okta): routes to includedOauth2ProviderConfig', async () => {
    mockSend.mockResolvedValue({ credentialProviderArn: 'arn:test' });

    await createOAuth2Provider(makeMockClient(), {
      name: 'okta',
      vendor: 'OktaOauth2',
      clientId: 'cid',
      clientSecret: 'csec',
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const sentInput = mockSend.mock.calls[0]![0].input;
    expect(sentInput.credentialProviderVendor).toBe('OktaOauth2');
    expect(sentInput.oauth2ProviderConfigInput.includedOauth2ProviderConfig.clientId).toBe('cid');
  });

  it('included vendor with issuer: includes issuer in includedOauth2ProviderConfig', async () => {
    mockSend.mockResolvedValue({ credentialProviderArn: 'arn:test' });

    await createOAuth2Provider(makeMockClient(), {
      name: 'okta',
      vendor: 'OktaOauth2',
      clientId: 'cid',
      clientSecret: 'csec',
      issuer: 'https://dev-123.okta.com',
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const sentInput = mockSend.mock.calls[0]![0].input;
    expect(sentInput.oauth2ProviderConfigInput.includedOauth2ProviderConfig.issuer).toBe('https://dev-123.okta.com');
  });

  it('included vendor with endpoints: includes authorizationEndpoint and tokenEndpoint', async () => {
    mockSend.mockResolvedValue({ credentialProviderArn: 'arn:test' });

    await createOAuth2Provider(makeMockClient(), {
      name: 'okta',
      vendor: 'OktaOauth2',
      clientId: 'cid',
      clientSecret: 'csec',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const sentInput = mockSend.mock.calls[0]![0].input;
    expect(sentInput.oauth2ProviderConfigInput.includedOauth2ProviderConfig.authorizationEndpoint).toBe(
      'https://auth.example.com/authorize'
    );
    expect(sentInput.oauth2ProviderConfigInput.includedOauth2ProviderConfig.tokenEndpoint).toBe(
      'https://auth.example.com/token'
    );
  });

  it('custom vendor: routes to customOauth2ProviderConfig with discoveryUrl', async () => {
    mockSend.mockResolvedValue({ credentialProviderArn: 'arn:test' });

    await createOAuth2Provider(makeMockClient(), {
      name: 'custom',
      vendor: 'CustomOauth2',
      discoveryUrl: 'https://example.com/.well-known/openid-configuration',
      clientId: 'cid',
      clientSecret: 'csec',
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const sentInput = mockSend.mock.calls[0]![0].input;
    expect(sentInput.credentialProviderVendor).toBe('CustomOauth2');
    expect(sentInput.oauth2ProviderConfigInput.customOauth2ProviderConfig.oauthDiscovery.discoveryUrl).toBe(
      'https://example.com/.well-known/openid-configuration'
    );
  });
});
