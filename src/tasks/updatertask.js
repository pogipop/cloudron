'use strict';

require('supererror')({ splatchError: true });

let database = require('../database.js'),
    debug = require('debug')('box:updatertask'),
    tasks = require('../tasks.js'),
    updater = require('../updater.js');

const NOOP_CALLBACK = function (error) { if (error) debug(error); };

process.on('SIGTERM', function () {
    process.exit(0);
});

function exit(error) {
    if (!error) process.exit(0);

    debug(error);
    process.exit(50);
}

// Main process starts here
debug('Staring update');
database.initialize(function (error) {
    if (error) return exit(error);

    tasks.get(tasks.TASK_UPDATE, function (error, result) {
        if (error) return exit(error);
        if (!result.args.boxUpdateInfo) return exit(new Error('Invalid args:' + JSON.stringify(result)));

        updater.update(result.args.boxUpdateInfo, (progress) => tasks.update(tasks.TASK_UPDATE, progress, NOOP_CALLBACK), function (updateError) {
            const progress = { percent: 100, errorMessage: updateError ? updateError.message : '' };

            tasks.update(tasks.TASK_UPDATE, progress, () => exit(updateError));
        });
    });
});
