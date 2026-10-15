import { describe, it, expect } from 'vitest';
import { folderPathFromArg } from '@/lib/connection-folder';

describe('folderPathFromArg', () => {
  it('passes a non-empty folder path through', () => {
    expect(folderPathFromArg('Work')).toBe('Work');
    expect(folderPathFromArg('Work/ProjectA')).toBe('Work/ProjectA');
  });

  it('treats undefined and the empty string as "no folder"', () => {
    expect(folderPathFromArg(undefined)).toBeUndefined();
    expect(folderPathFromArg('')).toBeUndefined();
  });

  it('ignores a click event leaked by onClick={handler}', () => {
    const event = new MouseEvent('click');
    expect(folderPathFromArg(event)).toBeUndefined();
    expect(folderPathFromArg({ nativeEvent: event, target: document.body })).toBeUndefined();
  });

  it('ignores other non-string values', () => {
    expect(folderPathFromArg(42)).toBeUndefined();
    expect(folderPathFromArg(null)).toBeUndefined();
    expect(folderPathFromArg(['Work'])).toBeUndefined();
  });
});
