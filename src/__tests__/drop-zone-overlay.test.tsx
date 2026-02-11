import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { DropZoneOverlay, getZoneFromPosition } from '../components/terminal/drop-zone-overlay';

const makeRect = (left: number, top: number, width: number, height: number): DOMRect => ({
  left, top, width, height,
  right: left + width, bottom: top + height,
  x: left, y: top, toJSON: () => {},
});

describe('getZoneFromPosition', () => {
  const rect = makeRect(0, 0, 400, 400);

  it('returns "up" when mouse is in top 25%', () => {
    expect(getZoneFromPosition(200, 50, rect)).toBe('up');
    expect(getZoneFromPosition(200, 0, rect)).toBe('up');
    expect(getZoneFromPosition(200, 99, rect)).toBe('up');
  });

  it('returns "down" when mouse is in bottom 25%', () => {
    expect(getZoneFromPosition(200, 350, rect)).toBe('down');
    expect(getZoneFromPosition(200, 400, rect)).toBe('down');
    expect(getZoneFromPosition(200, 301, rect)).toBe('down');
  });

  it('returns "left" when mouse is in left 25% (not top/bottom)', () => {
    expect(getZoneFromPosition(50, 200, rect)).toBe('left');
    expect(getZoneFromPosition(0, 200, rect)).toBe('left');
    expect(getZoneFromPosition(99, 200, rect)).toBe('left');
  });

  it('returns "right" when mouse is in right 25% (not top/bottom)', () => {
    expect(getZoneFromPosition(350, 200, rect)).toBe('right');
    expect(getZoneFromPosition(400, 200, rect)).toBe('right');
    expect(getZoneFromPosition(301, 200, rect)).toBe('right');
  });

  it('returns "center" when mouse is in the middle', () => {
    expect(getZoneFromPosition(200, 200, rect)).toBe('center');
    expect(getZoneFromPosition(150, 150, rect)).toBe('center');
    expect(getZoneFromPosition(250, 250, rect)).toBe('center');
  });

  it('prioritizes vertical edges over horizontal edges in corners', () => {
    // Top-left corner: top 25% takes priority over left 25%
    expect(getZoneFromPosition(50, 50, rect)).toBe('up');
    // Bottom-right corner: bottom 25% takes priority over right 25%
    expect(getZoneFromPosition(350, 350, rect)).toBe('down');
  });

  it('handles offset rect correctly', () => {
    const offsetRect = makeRect(100, 100, 400, 400);
    // clientX=150, relX = (150-100)/400 = 0.125 → left
    // clientY=300, relY = (300-100)/400 = 0.5 → not top/bottom
    expect(getZoneFromPosition(150, 300, offsetRect)).toBe('left');
  });
});

describe('DropZoneOverlay component', () => {
  const mockOnDrop = vi.fn();

  beforeEach(() => {
    mockOnDrop.mockClear();
  });

  it('renders nothing when visible is false', () => {
    const { container } = render(
      <DropZoneOverlay groupId="g1" visible={false} onDrop={mockOnDrop} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders overlay container when visible is true', () => {
    const { getByTestId } = render(
      <DropZoneOverlay groupId="g1" visible={true} onDrop={mockOnDrop} />,
    );
    expect(getByTestId('drop-zone-overlay-g1')).toBeTruthy();
  });

  it('shows no zone highlight initially', () => {
    const { queryByTestId } = render(
      <DropZoneOverlay groupId="g1" visible={true} onDrop={mockOnDrop} />,
    );
    expect(queryByTestId('drop-zone-up')).toBeNull();
    expect(queryByTestId('drop-zone-down')).toBeNull();
    expect(queryByTestId('drop-zone-left')).toBeNull();
    expect(queryByTestId('drop-zone-right')).toBeNull();
    expect(queryByTestId('drop-zone-center')).toBeNull();
  });

  it('calls onDrop on drop event when a zone is active', () => {
    const { getByTestId } = render(
      <DropZoneOverlay groupId="g1" visible={true} onDrop={mockOnDrop} />,
    );
    const overlay = getByTestId('drop-zone-overlay-g1');

    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(makeRect(0, 0, 400, 400));

    // dragOver sets the zone, then drop triggers onDrop
    fireEvent.dragOver(overlay, { clientX: 200, clientY: 200 });
    fireEvent.drop(overlay);

    expect(mockOnDrop).toHaveBeenCalledTimes(1);
  });

  it('clears zone highlight on drag leave', () => {
    const { getByTestId, queryByTestId } = render(
      <DropZoneOverlay groupId="g1" visible={true} onDrop={mockOnDrop} />,
    );
    const overlay = getByTestId('drop-zone-overlay-g1');

    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(makeRect(0, 0, 400, 400));

    fireEvent.dragOver(overlay, { clientX: 200, clientY: 200 });
    // Some zone should be highlighted
    fireEvent.dragLeave(overlay);
    // All zones should be cleared
    expect(queryByTestId('drop-zone-up')).toBeNull();
    expect(queryByTestId('drop-zone-down')).toBeNull();
    expect(queryByTestId('drop-zone-left')).toBeNull();
    expect(queryByTestId('drop-zone-right')).toBeNull();
    expect(queryByTestId('drop-zone-center')).toBeNull();
  });
});
