import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MenuBar } from '../components/menu-bar';

describe('MenuBar update pill', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders no pill when there is no announcement', () => {
    render(<MenuBar />);

    expect(screen.queryByText(/Update to /)).toBeNull();
    expect(screen.queryByText('Restart to Update')).toBeNull();
  });

  it('shows the available-update pill with the version and opens the dialog on click', () => {
    const onOpenUpdateDialog = vi.fn();
    render(
      <MenuBar
        updateAnnouncement={{ version: '2.9.3', ready: false }}
        onOpenUpdateDialog={onOpenUpdateDialog}
      />
    );

    fireEvent.click(screen.getByText('Update to 2.9.3'));
    expect(onOpenUpdateDialog).toHaveBeenCalledOnce();
  });

  it('switches to the restart variant once the update is ready', () => {
    const onOpenUpdateDialog = vi.fn();
    render(
      <MenuBar
        updateAnnouncement={{ version: '2.9.3', ready: true }}
        onOpenUpdateDialog={onOpenUpdateDialog}
      />
    );

    expect(screen.getByText('Restart to Update')).toBeTruthy();
    expect(screen.queryByText(/Update to /)).toBeNull();

    fireEvent.click(screen.getByText('Restart to Update'));
    expect(onOpenUpdateDialog).toHaveBeenCalledOnce();
  });
});
