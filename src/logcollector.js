'use strict';

exports = module.exports = {
    sendFailureLogs: sendFailureLogs
};

var assert = require('assert'),
    mailer = require('./mailer.js'),
    safe = require('safetydance'),
    path = require('path'),
    util = require('util');

var COLLECT_LOGS_CMD = path.join(__dirname, 'scripts/collectlogs.sh');

var CRASH_LOG_TIMESTAMP_OFFSET = 1000 * 60 * 30; // 30 min
var CRASH_LOG_TIMESTAMP_FILE = '/tmp/crashlog.timestamp';
var CRASH_LOG_STASH_FILE = '/tmp/crashlog';

function collectLogs(unitName, callback) {
    assert.strictEqual(typeof unitName, 'string');
    assert.strictEqual(typeof callback, 'function');

    var logs = safe.child_process.execSync('sudo ' + COLLECT_LOGS_CMD + ' ' + unitName, { encoding: 'utf8' });
    logs = '\n\n======= ' + unitName + ' =======\n\n' + logs + '\n\n';

    callback(null, logs);
}

function stashLogs(logs) {
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

        mailer.unexpectedExit(processName, compiledLogs, function (error) {
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
