'use strict';

exports = module.exports = {
    sendFailureLogs: sendFailureLogs
};

var assert = require('assert'),
    notifications = require('./notifications.js'),
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

    // append here
    safe.fs.writeFileSync(CRASH_LOG_STASH_FILE, logs, { flag: 'a' });
}

function sendFailureLogs(processName, options) {
    assert.strictEqual(typeof processName, 'string');
    assert.strictEqual(typeof options, 'object');

    collectLogs(options.unit || processName, function (error, newLogs) {
        if (error) {
            console.error('Failed to collect logs.', error);
            newLogs = util.format('Failed to collect logs.', error);
        }

        console.log('Sending failure logs for', processName);

        var timestamp = safe.fs.readFileSync(CRASH_LOG_TIMESTAMP_FILE, 'utf8');

        // check if we already sent a mail in the last CRASH_LOG_TIME_OFFSET window
        if (timestamp && (parseInt(timestamp) + CRASH_LOG_TIMESTAMP_OFFSET) > Date.now()) {
            console.log('Crash log already sent within window. Stashing logs.');
            return stashLogs(newLogs);
        }

        var stashedLogs = safe.fs.readFileSync(CRASH_LOG_STASH_FILE, 'utf8');
        var compiledLogs = stashedLogs ? (stashedLogs + newLogs) : newLogs;
        var subject = `${processName} ${stashedLogs ? ' and others' : ''} exited unexpectedly`;

        notifications.unexpectedExit(subject, compiledLogs, function (error) {
            if (error) {
                console.log('Error sending crashlog. Stashing logs.');
                return stashLogs(newLogs);
            }

            // write the new timestamp file and delete stash file
            safe.fs.writeFileSync(CRASH_LOG_TIMESTAMP_FILE, String(Date.now()));
            safe.fs.unlinkSync(CRASH_LOG_STASH_FILE);
        });
    });
}
