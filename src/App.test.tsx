import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App, { APP_NAME } from './App';

describe('App', () => {
  it('renders the application name', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: APP_NAME })).toBeInTheDocument();
  });
});
