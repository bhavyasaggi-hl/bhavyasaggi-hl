/**
 * Request/response message handlers for the popup, panel and options pages.
 *
 * Only messages originating from this extension are served, and every record
 * leaves through `redactForUi`. The panel's live stream is separate — see
 * `stream.ts`.
 */

import { errorMessage, logger } from '../shared/logger.ts';
import type { Request, Response, ResponseMap } from '../shared/messages.ts';
import { whenReady } from './bootstrap.ts';
import { getConfigStatus, getConfigText, resetConfig, setConfigText } from './config-store.ts';
import { ingestRecords, notePageLoad, reevaluate } from './ingest.ts';
import { getRecord } from './store.ts';
import { notifyTabReset } from './stream.ts';

async function handle(request: Request): Promise<ResponseMap[Request['type']]> {
  await whenReady();
  switch (request.type) {
    case 'getConfig':
      return { text: getConfigText(), status: getConfigStatus() };

    case 'setConfig': {
      const status = await setConfigText(request.text);
      return { text: request.text, status };
    }

    case 'resetConfig': {
      const status = await resetConfig();
      return { text: getConfigText(), status };
    }

    case 'ingest':
      return { accepted: ingestRecords(request.records) };

    case 'attachBody': {
      const record = getRecord(request.id);
      if (record !== undefined) {
        record.responseBody = request.body;
        reevaluate(record);
      }
      return { ok: true };
    }

    case 'setPage':
      if (notePageLoad(request.tabId, request.url)) {
        notifyTabReset(request.tabId);
      }
      return { ok: true };

    default: {
      const exhaustive: never = request;
      throw new Error(`Unsupported request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Registers the runtime message listener. Must run synchronously at worker start-up. */
export function registerRpc(): void {
  chrome.runtime.onMessage.addListener(
    (
      request: Request,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: Response<Request['type']>) => void,
    ): boolean => {
      if (sender.id !== chrome.runtime.id) {
        sendResponse({
          ok: false,
          error: 'Rejected: message did not originate from this extension.',
        });
        return false;
      }
      handle(request)
        .then((data) => {
          sendResponse({ ok: true, data });
        })
        .catch((cause: unknown) => {
          logger.error('message handler failed', request.type, cause);
          sendResponse({ ok: false, error: errorMessage(cause) });
        });
      return true;
    },
  );
}
