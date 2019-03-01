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

const COLLECT_LOGS_CMD = path.join(__dirname, 'scripts/collectlogs.sh');

const CRASH_LOG_TIMESTAMP_OFFSET = 1000 * 60 * 60; // 60 min
const CRASH_LOG_TIMESTAMP_FILE = '/tmp/crashlog.timestamp';

const AUDIT_SOURCE = { userId: null, username: 'healthmonitor' };

function collectLogs(unitName, callback) {
    assert.strictEqual(typeof unitName, 'string');
    assert.strictEqual(typeof callback, 'function');

    var logs = safe.child_process.execSync('sudo ' + COLLECT_LOGS_CMD + ' ' + unitName, { encoding: 'utf8' });
    if (!logs) return callback(safe.error);

    callback(null, logs);
}

function sendFailureLogs(unitName, callback) {
    assert.strictEqual(typeof unitName, 'string');
    assert.strictEqual(typeof callback, 'function');

    // check if we already sent a mail in the last CRASH_LOG_TIME_OFFSET window
    const timestamp = safe.fs.readFileSync(CRASH_LOG_TIMESTAMP_FILE, 'utf8');
    if (timestamp && (parseInt(timestamp) + CRASH_LOG_TIMESTAMP_OFFSET) > Date.now()) {
        console.log('Crash log already sent within window');
        return callback();
    }

    collectLogs(unitName, function (error, logs) {
        if (error) {
            console.error('Failed to collect logs.', error);
            logs = util.format('Failed to collect logs.', error);
        }

        const crashId = `${new Date().toISOString()}`;
        console.log(`Creating crash log for ${unitName} with id ${crashId}`);

        if (!safe.fs.writeFileSync(path.join(paths.CRASH_LOG_DIR, `${crashId}.log`), logs)) console.log(`Failed to stash logs to ${crashLogFile}:`, safe.error);

        eventlog.add(eventlog.ACTION_PROCESS_CRASH, AUDIT_SOURCE, { processName: unitName, crashId: crashId }, function (error) {
            if (error) console.log(`Error sending crashlog. Logs stashed at ${crashId}.log`);

            safe.fs.writeFileSync(CRASH_LOG_TIMESTAMP_FILE, String(Date.now()));

            callback();
        });
    });
}
