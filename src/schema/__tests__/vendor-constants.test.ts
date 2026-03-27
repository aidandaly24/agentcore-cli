import { INCLUDED_PROVIDERS, NAMED_PROVIDER_CONFIG_KEYS, vendorRequiresDiscoveryUrl } from '../../schema/constants.js';
import { describe, expect, it } from 'vitest';

describe('NAMED_PROVIDER_CONFIG_KEYS', () => {
  it('has exactly 7 entries', () => {
    expect(Object.keys(NAMED_PROVIDER_CONFIG_KEYS)).toHaveLength(7);
  });

  it('contains GoogleOauth2', () => {
    expect(NAMED_PROVIDER_CONFIG_KEYS.GoogleOauth2).toBe('googleOauth2ProviderConfig');
  });

  it('contains GithubOauth2', () => {
    expect(NAMED_PROVIDER_CONFIG_KEYS.GithubOauth2).toBe('githubOauth2ProviderConfig');
  });

  it('contains SlackOauth2', () => {
    expect(NAMED_PROVIDER_CONFIG_KEYS.SlackOauth2).toBe('slackOauth2ProviderConfig');
  });

  it('contains SalesforceOauth2', () => {
    expect(NAMED_PROVIDER_CONFIG_KEYS.SalesforceOauth2).toBe('salesforceOauth2ProviderConfig');
  });

  it('contains MicrosoftOauth2', () => {
    expect(NAMED_PROVIDER_CONFIG_KEYS.MicrosoftOauth2).toBe('microsoftOauth2ProviderConfig');
  });

  it('contains AtlassianOauth2', () => {
    expect(NAMED_PROVIDER_CONFIG_KEYS.AtlassianOauth2).toBe('atlassianOauth2ProviderConfig');
  });

  it('contains LinkedinOauth2', () => {
    expect(NAMED_PROVIDER_CONFIG_KEYS.LinkedinOauth2).toBe('linkedinOauth2ProviderConfig');
  });
});

describe('INCLUDED_PROVIDERS', () => {
  it('has exactly 17 entries', () => {
    expect(INCLUDED_PROVIDERS.size).toBe(17);
  });

  it('contains Auth0Oauth2', () => {
    expect(INCLUDED_PROVIDERS.has('Auth0Oauth2')).toBe(true);
  });

  it('contains CognitoOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('CognitoOauth2')).toBe(true);
  });

  it('contains CyberArkOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('CyberArkOauth2')).toBe(true);
  });

  it('contains DropboxOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('DropboxOauth2')).toBe(true);
  });

  it('contains FacebookOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('FacebookOauth2')).toBe(true);
  });

  it('contains FusionAuthOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('FusionAuthOauth2')).toBe(true);
  });

  it('contains HubspotOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('HubspotOauth2')).toBe(true);
  });

  it('contains NotionOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('NotionOauth2')).toBe(true);
  });

  it('contains OktaOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('OktaOauth2')).toBe(true);
  });

  it('contains OneLoginOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('OneLoginOauth2')).toBe(true);
  });

  it('contains PingOneOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('PingOneOauth2')).toBe(true);
  });

  it('contains RedditOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('RedditOauth2')).toBe(true);
  });

  it('contains SpotifyOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('SpotifyOauth2')).toBe(true);
  });

  it('contains TwitchOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('TwitchOauth2')).toBe(true);
  });

  it('contains XOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('XOauth2')).toBe(true);
  });

  it('contains YandexOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('YandexOauth2')).toBe(true);
  });

  it('contains ZoomOauth2', () => {
    expect(INCLUDED_PROVIDERS.has('ZoomOauth2')).toBe(true);
  });
});

describe('vendorRequiresDiscoveryUrl', () => {
  it('returns false for a Named vendor (GoogleOauth2)', () => {
    expect(vendorRequiresDiscoveryUrl('GoogleOauth2')).toBe(false);
  });

  it('returns false for a Named vendor (GithubOauth2)', () => {
    expect(vendorRequiresDiscoveryUrl('GithubOauth2')).toBe(false);
  });

  it('returns false for a Named vendor (SlackOauth2)', () => {
    expect(vendorRequiresDiscoveryUrl('SlackOauth2')).toBe(false);
  });

  it('returns false for a Named vendor (SalesforceOauth2)', () => {
    expect(vendorRequiresDiscoveryUrl('SalesforceOauth2')).toBe(false);
  });

  it('returns false for a Named vendor (MicrosoftOauth2)', () => {
    expect(vendorRequiresDiscoveryUrl('MicrosoftOauth2')).toBe(false);
  });

  it('returns false for a Named vendor (AtlassianOauth2)', () => {
    expect(vendorRequiresDiscoveryUrl('AtlassianOauth2')).toBe(false);
  });

  it('returns false for a Named vendor (LinkedinOauth2)', () => {
    expect(vendorRequiresDiscoveryUrl('LinkedinOauth2')).toBe(false);
  });

  it('returns false for an Included vendor (Auth0Oauth2)', () => {
    expect(vendorRequiresDiscoveryUrl('Auth0Oauth2')).toBe(false);
  });

  it('returns false for an Included vendor (OktaOauth2)', () => {
    expect(vendorRequiresDiscoveryUrl('OktaOauth2')).toBe(false);
  });

  it('returns false for an Included vendor (ZoomOauth2)', () => {
    expect(vendorRequiresDiscoveryUrl('ZoomOauth2')).toBe(false);
  });

  it('returns true for CustomOauth2', () => {
    expect(vendorRequiresDiscoveryUrl('CustomOauth2')).toBe(true);
  });

  it('returns true for an unknown vendor string', () => {
    expect(vendorRequiresDiscoveryUrl('UnknownOauth2')).toBe(true);
  });

  it('returns true for an empty string', () => {
    expect(vendorRequiresDiscoveryUrl('')).toBe(true);
  });
});
