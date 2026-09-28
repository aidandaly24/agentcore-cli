import { matchSdkFramework } from '../../../schema';
import {
  applyTemplateOptionDefaults,
  getTemplateProfile,
  templateNeedsPythonVenv,
  templateUsesModel,
  validateTemplateOptions,
} from '../profiles.js';
import { describe, expect, it } from 'vitest';

describe('template profiles', () => {
  it('gives no profile for a framework without one, for an unknown name, or for an object property name', () => {
    for (const framework of ['Strands', 'VercelAI', 'NoSuchFramework', 'constructor', 'toString', undefined]) {
      expect(getTemplateProfile(framework)).toBeUndefined();
    }
  });

  it('uses a model and a Python venv when the framework has no profile', () => {
    expect(templateUsesModel('Strands')).toBe(true);
    expect(templateNeedsPythonVenv('Strands')).toBe(true);
    expect(templateUsesModel(undefined)).toBe(true);
    expect(templateNeedsPythonVenv(undefined)).toBe(true);
  });

  it('reads the profile of the framework', () => {
    expect(templateUsesModel('BedrockManagedAgents')).toBe(false);
    expect(templateNeedsPythonVenv('BedrockManagedAgents')).toBe(false);
  });

  it('changes no option and gives no error when the framework has no profile', () => {
    const options = { type: 'byo', memory: 'shortTerm', build: 'CodeZip' };
    applyTemplateOptionDefaults('Strands', options);
    expect(options).toEqual({ type: 'byo', memory: 'shortTerm', build: 'CodeZip' });
    expect(validateTemplateOptions('Strands', options)).toBeUndefined();
  });

  it('keeps options that the user gives', () => {
    const options = { modelProvider: 'Bedrock', language: 'Python', memory: 'none', build: 'Container' };
    applyTemplateOptionDefaults('BedrockManagedAgents', options);
    expect(options).toEqual({ modelProvider: 'Bedrock', language: 'Python', memory: 'none', build: 'Container' });
    expect(validateTemplateOptions('BedrockManagedAgents', options)).toBeUndefined();
  });

  it('matches a short name only from the alias table, not from object properties', () => {
    expect(matchSdkFramework('BMA')).toBe('BedrockManagedAgents');
    expect(matchSdkFramework('strands')).toBe('Strands');
    for (const input of ['constructor', '__proto__', 'toString']) {
      expect(matchSdkFramework(input)).toBeUndefined();
    }
  });
});
