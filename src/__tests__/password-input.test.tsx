import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PasswordInput } from '../components/ui/password-input';

describe('PasswordInput', () => {
  it('renders masked by default with a show toggle', () => {
    render(<PasswordInput id="pw" />);
    const input = document.getElementById('pw') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(screen.getByRole('button', { name: 'Show password' })).toBeTruthy();
  });

  it('reveals the value when toggled and hides it again', () => {
    render(<PasswordInput id="pw" />);
    const input = document.getElementById('pw') as HTMLInputElement;

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input.type).toBe('password');
  });

  it('passes through value and change events', () => {
    const onChange = vi.fn();
    render(<PasswordInput id="pw" value="s3cret" onChange={onChange} />);
    const input = document.getElementById('pw') as HTMLInputElement;
    expect(input.value).toBe('s3cret');
    fireEvent.change(input, { target: { value: 'new' } });
    expect(onChange).toHaveBeenCalled();
  });
});
