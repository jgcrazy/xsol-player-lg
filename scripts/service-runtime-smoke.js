'use strict';

// Runs under each Node.js version webOS ships (0.12.2 upward): parses every
// compiled service file with that runtime, then drives the reminder service
// through a stand-in Luna bus.

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var buildDir = process.env.SERVICE_BUILD_DIR;
if (!buildDir) throw new Error('SERVICE_BUILD_DIR is required');

var parsedFiles = 0;
function parseBuild(dir) {
  fs.readdirSync(dir).forEach(function (name) {
    var file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) {
      parseBuild(file);
    } else if (/\.js$/.test(name)) {
      new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
      parsedFiles++;
    }
  });
}
parseBuild(buildDir);

function fail(message) {
  console.error(message);
  process.exit(1);
}

var handlers = {};
var service = {
  register: function (method, handler) { handlers[method] = handler; },
};
require(path.join(buildDir, 'reminder', 'service')).registerReminderService(service);

['getDevMode', 'fireReminderAlert'].forEach(function (method) {
  if (typeof handlers[method] !== 'function') fail('Luna method not registered: ' + method);
});

var devMode;
handlers.getDevMode({ respond: function (response) { devMode = response; } });
if (!devMode || typeof devMode.devmode !== 'boolean') {
  fail('getDevMode returned ' + JSON.stringify(devMode));
}

// An alert without its localized copy is refused before anything is executed.
var refused;
handlers.fireReminderAlert({
  payload: { copyVersion: 1, title: 'Program 1', channelName: 'ch1', channelKey: 'k1', appId: 'app1' },
  respond: function (response) { refused = response; },
});
if (!refused || refused.fired !== false) {
  fail('fireReminderAlert accepted an incomplete payload: ' + JSON.stringify(refused));
}

// The compat helpers stay part of the build for the oldest runtime.
var compat = require(path.join(buildDir, 'compat'));
if (compat.padStart('7', 3, '0') !== '007' || !compat.stringEndsWith('a.m3u', '.m3u')) {
  fail('compat helpers returned unexpected values');
}

console.log(process.version + ' service smoke passed (' + parsedFiles + ' compiled files)');
