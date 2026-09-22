/**
 * DevTools entry point.
 *
 * Runs in the hidden devtools page for as long as DevTools is open on the tab,
 * which makes it the right place to both register the panel and drive capture —
 * the panel's own page does not exist until the user selects its tab.
 */

import { startCapture } from './capture.ts';

chrome.devtools.panels.create('Residency', 'icons/icon48.png', 'panel.html');

startCapture(chrome.devtools.inspectedWindow.tabId);
