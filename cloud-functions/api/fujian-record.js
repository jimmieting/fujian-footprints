import { getStore } from '@edgeone/pages-blob';
import { createRecordHandler } from '../_lib/fujian-record-core.js';

let handler;

export default async function onRequest({ request }) {
  handler ??= createRecordHandler({
    store: getStore({ name: 'fujian-footprints-v1', consistency: 'strong' }),
  });
  return handler(request);
}
