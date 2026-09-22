/** DevTools panel entry point. */

import { StrictMode } from 'preact/compat';
import { createRoot } from 'preact/compat/client';
import '../../styles/tailwind.css';
import { mount } from '../lib/mount.ts';
import { Panel } from './Panel.tsx';

createRoot(mount()).render(
  <StrictMode>
    <Panel tabId={chrome.devtools.inspectedWindow.tabId} />
  </StrictMode>,
);
