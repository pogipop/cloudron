'use strict';

exports = module.exports = {
    sendFailureLogs: sendFailureLogs
};

var assert = require('assert'),
    eventlog = require('./eventlog.js'),
    safe = require('safetydance'),
    path = require('path'),
    util = require('util');

var COLLECT_LOGS_CMD = path.join(__dirname, 'scripts/collectlogs.sh');

var CRASH_LOG_TIMESTAMP_OFFSET = 1000 * 60 * 60; // 60 min
var CRASH_LOG_TIMESTAMP_FILE = '/tmp/crashlog.timestamp';
var CRASH_LOG_STASH_FILE = '/tmp/crashlog';
var CRASH_LOG_FILE_LIMIT = 2 * 1024 * 1024; // 2mb

function collectLogs(unitName, callback) {
    assert.strictEqual(typeof unitName, 'string');
    assert.strictEqual(typeof callback, 'function');

    var logs = safe.child_process.execSync('sudo ' + COLLECT_LOGS_CMD + ' ' + unitName, { encoding: 'utf8' });
    if (!logs) return callback(safe.error);

    logs = logs + '\n\n=====================================\n\n';

    callback(null, logs);
}

function stashLogs(logs) {
    var stat = safe.fs.statSync(CRASH_LOG_STASH_FILE);
    if (stat && (stat.size > CRASH_LOG_FILE_LIMIT)) {
        console.error('Dropping logs since crash file has become too big');
        return;
    }

    safe.fs.writeFileSync(CRASH_LOG_STASH_FILE, logs);
}

function sendFailureLogs(unitName) {
    assert.strictEqual(typeof unitName, 'string');

    collectLogs(unitName, function (error, newLogs) {
        if (error) {
            console.error('Failed to collect logs.', error);
            newLogs = util.format('Failed to collect logs.', error);
        }

        console.log('Sending failure logs for', unitName);

        var timestamp = safe.fs.readFileSync(CRASH_LOG_TIMESTAMP_FILE, 'utf8');

        // check if we already sent a mail in the last CRASH_LOG_TIME_OFFSET window
        if (timestamp && (parseInt(timestamp) + CRASH_LOG_TIMESTAMP_OFFSET) > Date.now()) {
            console.log('Crash log already sent within window. Stashing logs.');
            return stashLogs(newLogs);
        }

        eventlog.add(eventlog.ACTION_PROCESS_CRASH, { processName: unitName }, { crashLogFile: CRASH_LOG_STASH_FILE }, function (error) {
            if (error) {
                console.log(`Error sending crashlog. Logs stashed at ${CRASH_LOG_STASH_FILE}`);
                return stashLogs(newLogs);
            }

            // write the new timestamp file and delete stash file
            safe.fs.writeFileSync(CRASH_LOG_TIMESTAMP_FILE, String(Date.now()));
        });
    });
}
