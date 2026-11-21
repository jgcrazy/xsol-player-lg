/**
 * Bundled webOS JS service for the player — thin entry point.
 *
 * Binds the Luna service and wires up the reminder alerts (dev-mode interactive
 * createAlert; see reminder/). The service opens no network listener: device
 * setup happens through the activation panel, not over the LAN.
 */

import { registerReminderService } from './reminder/service';

// Service id from services.json — the file webOS hubd reads to register
// this service on the Luna bus. Passing anything else into `new Service()`
// would fail to bind.
const SERVICE_ID: string = require('./services.json').id;

console.log('[service] starting, SERVICE_ID=' + SERVICE_ID);

let Service;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Service = require('webos-service');
} catch (e) {
  console.log('[service] webos-service not available (' + (e instanceof Error ? e.message : String(e)) +
    '); nothing to do off-device');
}

if (Service) {
  try {
    const service = new Service(SERVICE_ID);
    console.log('[service] registered with Luna as ' + SERVICE_ID);
    registerReminderService(service);
  } catch (e) {
    console.error('[service] failed to register Luna service:', e);
    throw e;
  }
}
