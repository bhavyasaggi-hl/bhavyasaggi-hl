/** Popup entry point. */

import { StrictMode } from 'preact/compat';
import { createRoot } from 'preact/compat/client';
import '../../styles/tailwind.css';
import { mount } from '../lib/mount.ts';
import { Popup } from './Popup.tsx';

createRoot(mount()).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
