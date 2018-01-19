#!/usr/bin/env node

'use strict';

var database = require('./src/database.js');

var sendFailureLogs = require('./src/logcollector').sendFailureLogs;

function main() {
    if (process.argv.length !== 3) return console.error('Usage: crashnotifier.js <processName>');

    var processName = process.argv[2];
    console.log('Started crash notifier for', processName);

    // mailer needs the db
    database.initialize(function (error) {
        if (error) return console.error('Cannot connect to database. Unable to send crash log.', error);

        sendFailureLogs(processName, { unit: processName });
    });
}

main();
