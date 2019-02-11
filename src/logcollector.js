'use strict';

exports = module.exports = {
    sendFailureLogs: sendFailureLogs
};

var assert = require('assert'),
    eventlog = require('./eventlog.js'),
    safe = require('safetydance'),
    path = require('path'),
    paths = require('./paths.js'),
    util = require('util');

var COLLECT_LOGS_CMD = path.join(__dirname, 'scripts/collectlogs.sh');

var CRASH_LOG_TIMESTAMP_OFFSET = 1000 * 60 * 60; // 60 min
var CRASH_LOG_TIMESTAMP_FILE = '/tmp/crashlog.timestamp';
var CRASH_LOG_STASH_FILE = '/tmp/crashlog';

const AUDIT_SOURCE = { userId: null, username: 'healthmonitor' };

function collectLogs(unitName, callback) {
    assert.strictEqual(typeof unitName, 'string');
    assert.strictEqual(typeof callback, 'function');

    var logs = safe.child_process.execSync('sudo ' + COLLECT_LOGS_CMD + ' ' + unitName, { encoding: 'utf8' });
    if (!logs) return callback(safe.error);

    logs = logs + '\n\n=====================================\n\n';

    // special case for box since the real logs are at path.join(paths.LOG_DIR, 'box.log')
    if (unitName === 'box.service') {
        logs += safe.child_process.execSync('tail --lines=500 ' + path.join(paths.LOG_DIR, 'box.log'), { encoding: 'utf8' });
    }

    callback(null, logs);
}

function sendFailureLogs(unitName) {
    assert.strictEqual(typeof unitName, 'string');

    collectLogs(unitName, function (error, logs) {
        if (error) {
            console.error('Failed to collect logs.', error);
            logs = util.format('Failed to collect logs.', error);
        }

        console.log('Sending failure logs for', unitName);

        if (!safe.fs.writeFileSync(CRASH_LOG_STASH_FILE, logs)) console.log(`Failed to stash logs to ${CRASH_LOG_STASH_FILE}`);

        var timestamp = safe.fs.readFileSync(CRASH_LOG_TIMESTAMP_FILE, 'utf8');

        // check if we already sent a mail in the last CRASH_LOG_TIME_OFFSET window
        if (timestamp && (parseInt(timestamp) + CRASH_LOG_TIMESTAMP_OFFSET) > Date.now()) {
            console.log('Crash log already sent within window. Stashing logs.');
            return;
        }

        eventlog.add(eventlog.ACTION_PROCESS_CRASH, AUDIT_SOURCE, { processName: unitName, crashLogFile: CRASH_LOG_STASH_FILE }, function (error) {
            if (error) console.log(`Error sending crashlog. Logs stashed at ${CRASH_LOG_STASH_FILE}`);

            // write the new timestamp file and delete stash file
            safe.fs.writeFileSync(CRASH_LOG_TIMESTAMP_FILE, String(Date.now()));
        });
    });
}
