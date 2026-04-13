export type FetchResourceType = 'gateway' | 'agent';

export interface FetchAccessOptions {
  name?: string;
  type?: FetchResourceType;
  deployTarget?: string;
  gatewayTarget?: string;
  identityName?: string;
  json?: boolean;
}
