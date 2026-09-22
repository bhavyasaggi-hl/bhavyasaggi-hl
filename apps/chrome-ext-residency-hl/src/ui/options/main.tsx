/** Options page entry point. */

import { StrictMode } from 'preact/compat';
import { createRoot } from 'preact/compat/client';
import '../../styles/tailwind.css';
import { mount } from '../lib/mount.ts';
import { Options } from './Options.tsx';

createRoot(mount()).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
