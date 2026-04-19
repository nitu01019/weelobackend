export {};

import { getErrorMessage, getErrorForLog } from '../shared/utils/error.utils';

describe('getErrorMessage', () => {
  it('extracts message from Error instance', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error');
  });

  it('returns string errors as-is', () => {
    expect(getErrorMessage('string error')).toBe('string error');
  });

  it('returns "Unknown error" for numbers', () => {
    expect(getErrorMessage(42)).toBe('Unknown error');
  });

  it('returns "Unknown error" for null', () => {
    expect(getErrorMessage(null)).toBe('Unknown error');
  });

  it('returns "Unknown error" for undefined', () => {
    expect(getErrorMessage(undefined)).toBe('Unknown error');
  });

  it('returns "Unknown error" for objects', () => {
    expect(getErrorMessage({ foo: 'bar' })).toBe('Unknown error');
  });
});

describe('getErrorForLog', () => {
  it('extracts message and stack from Error', () => {
    const err = new Error('test');
    const result = getErrorForLog(err);
    expect(result.message).toBe('test');
    expect(result.stack).toBeDefined();
  });

  it('converts non-Error to string', () => {
    expect(getErrorForLog(42)).toEqual({ message: '42' });
  });

  it('converts null to string', () => {
    expect(getErrorForLog(null)).toEqual({ message: 'null' });
  });
});
