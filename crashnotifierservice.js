#!/usr/bin/env node

'use strict';

var database = require('./src/database.js');

var crashNotifier = require('./src/crashnotifier.js');

// This is triggered by systemd with the crashed unit name as argument
function main() {
    if (process.argv.length !== 3) return console.error('Usage: crashnotifier.js <unitName>');

    var unitName = process.argv[2];
    console.log('Started crash notifier for', unitName);

    // eventlog api needs the db
    database.initialize(function (error) {
        if (error) return console.error('Cannot connect to database. Unable to send crash log.', error);

        crashNotifier.sendFailureLogs(unitName, function (error) {
            if (error) console.error(error);

            process.exit();
        });
    });
}

main();
