import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EditTagDialog } from '@/components/dialogs/EditTagDialog';

const updateProjectTagById = vi.fn();
vi.mock('@/stores/planner-store', () => ({
  usePlannerStore: { getState: () => ({ updateProjectTagById }) },
}));

// react-i18next: simple t() that echoes the key + interpolations
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe('EditTagDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <EditTagDialog open={false} project={{ name: 'Flow', tag: 'flow' } as any} onClose={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows current tag when open', () => {
    const { container } = render(
      <EditTagDialog open project={{ name: 'Flow', tag: 'flow' } as any} onClose={() => {}} />
    );
    // Current tag is rendered inside a <code> element next to the "current" label
    const code = container.querySelector('code');
    expect(code?.textContent).toBe('flow');
  });

  it('rejects invalid shape', () => {
    render(<EditTagDialog open project={{ name: 'Flow', tag: 'flow' } as any} onClose={() => {}} />);
    const input = screen.getByLabelText(/tags\.edit_new_label/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Bad-Tag' } });
    expect(screen.getByText('tags.edit_invalid_shape')).toBeInTheDocument();
  });

  it('rejects reserved word', () => {
    render(<EditTagDialog open project={{ name: 'Flow', tag: 'flow' } as any} onClose={() => {}} />);
    const input = screen.getByLabelText(/tags\.edit_new_label/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new' } });
    expect(screen.getByText('tags.edit_reserved')).toBeInTheDocument();
  });

  it('saves a valid tag', async () => {
    updateProjectTagById.mockReset();
    updateProjectTagById.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<EditTagDialog open project={{ name: 'Flow', tag: 'flow' } as any} onClose={onClose} />);
    const input = screen.getByLabelText(/tags\.edit_new_label/);
    fireEvent.change(input, { target: { value: 'growth' } });
    // Find the save button by its translated text
    const save = screen.getByText('tags.edit_save');
    fireEvent.click(save);
    await waitFor(() => expect(updateProjectTagById).toHaveBeenCalledWith('Flow', 'growth'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('disables save when tag equals current', () => {
    render(<EditTagDialog open project={{ name: 'Flow', tag: 'flow' } as any} onClose={() => {}} />);
    const save = screen.getByText('tags.edit_save').closest('button')!;
    expect(save).toBeDisabled();
  });

  it('disables save while saving', async () => {
    updateProjectTagById.mockReset();
    let release: () => void = () => {};
    updateProjectTagById.mockImplementation(() => new Promise((r) => { release = () => r(undefined); }));
    render(<EditTagDialog open project={{ name: 'Flow', tag: 'flow' } as any} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/tags\.edit_new_label/), { target: { value: 'growth' } });
    fireEvent.click(screen.getByText('tags.edit_save'));
    await waitFor(() => {
      expect(screen.getByText('tags.edit_save').closest('button')).toBeDisabled();
    });
    release();
  });
});
