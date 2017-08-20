'use strict';

/* global moment */
/* global Terminal */


angular.module('Application').controller('DebugController', ['$scope', '$location', 'Client', function ($scope, $location, Client) {
    Client.onReady(function () { if (!Client.getUserInfo().admin) $location.path('/'); });

    $scope.config = Client.getConfig();
    $scope.user = Client.getUserInfo();

    $scope.terminalVisible = true;
    $scope.logs = [];
    $scope.selected = '';
    $scope.activeEventSource = null;
    $scope.terminal = null;
    $scope.terminalSocket = null;
    $scope.lines = 10;
    $scope.restartAppBusy = false;

    function ab2str(buf) {
        return String.fromCharCode.apply(null, new Uint16Array(buf));
    }

    $scope.downloadFile = {
        filePath: '',

        downloadUrl: function () {
            var filePath = $scope.downloadFile.filePath.replace(/\/*\//g, '/');

            return Client.apiOrigin + '/api/v1/apps/' + $scope.selected.value + '/download?file=' + filePath + '&access_token=' + Client.getToken();
        },

        show: function () {
            $scope.downloadFile.filePath = '';
            $('#downloadFileModal').modal('show');
        },

        submit: function () {
            // we have to click the link to make the browser do the download
            $('#fileDownloadLink')[0].click();
        }
    };

    $scope.populateLogTypes = function () {
        $scope.logs.push({ name: 'System (All)', type: 'platform', value: 'all', url: Client.makeURL('/api/v1/cloudron/logs?units=all') });
        $scope.logs.push({ name: 'Box', type: 'platform', value: 'box', url: Client.makeURL('/api/v1/cloudron/logs?units=box') });
        $scope.logs.push({ name: 'Mail', type: 'platform', value: 'mail', url: Client.makeURL('/api/v1/cloudron/logs?units=mail') });

        Client.getInstalledApps().forEach(function (app) {
            $scope.logs.push({
                type: 'app',
                value: app.id,
                name: app.fqdn + ' (' + app.manifest.title + ')',
                url: Client.makeURL('/api/v1/apps/' + app.id + '/logs'),
                addons: app.manifest.addons
            });
        });

        $scope.selected = $scope.logs[0];
    };

    $scope.usesAddon = function (addon) {
        if (!$scope.selected || !$scope.selected.addons) return false;
        return !!Object.keys($scope.selected.addons).find(function (a) { return a === addon; });
    };

    function reset() {
        // close the old event source so we wont receive any new logs
        if ($scope.activeEventSource) {
            $scope.activeEventSource.close();
            $scope.activeEventSource = null;
        }

        var logViewer = $('.logs-and-term-container');
        logViewer.empty();

        if ($scope.terminal) {
            $scope.terminal.destroy();
            $scope.terminal = null;
        }

        if ($scope.terminalSocket) {
            $scope.terminalSocket = null;
        }
    }

    $scope.restartApp = function () {
        $scope.restartAppBusy = true;
        var appId = $scope.selected.value;

        function waitUntilStopped(callback) {
            Client.refreshInstalledApps(function (error) {
                if (error) return callback(error);

                Client.getApp(appId, function (error, result) {
                    if (error) return callback(error);

                    if (result.runState === 'stopped') return callback();
                    setTimeout(waitUntilStopped.bind(null, callback), 2000);
                });
            });
        }

        Client.stopApp(appId, function (error) {
            if (error) return console.error('Failed to stop app.', error);

            waitUntilStopped(function (error) {
                if (error) return console.error('Failed to get app status.', error);

                Client.startApp(appId, function (error) {
                    if (error) console.error('Failed to start app.', error);

                    $scope.restartAppBusy = false;
                });
            });
        });
    };

    $scope.showLogs = function () {
        $scope.terminalVisible = false;

        reset();

        if (!$scope.selected) return;

        var func = $scope.selected.type === 'platform' ? Client.getPlatformLogs : Client.getAppLogs;
        func($scope.selected.value, true, $scope.lines, function handleLogs(error, result) {
            if (error) return console.error(error);

            $scope.activeEventSource = result;
            result.onmessage = function handleMessage(message) {
                var data;

                try {
                    data = JSON.parse(message.data);
                } catch (e) {
                    return console.error(e);
                }

                // check if we want to auto scroll (this is before the appending, as that skews the check)
                var tmp = $('.logs-and-term-container');
                var autoScroll = tmp[0].scrollTop > (tmp[0].scrollTopMax - 24);

                var logLine = $('<div class="log-line">');
                var timeString = moment.utc(data.realtimeTimestamp/1000).format('MMM DD HH:mm:ss');
                logLine.html('<span class="time">' + timeString + ' </span>' + window.ansiToHTML(typeof data.message === 'string' ? data.message : ab2str(data.message)));
                tmp.append(logLine);

                if (autoScroll) tmp[0].lastChild.scrollIntoView({ behavior: 'instant', block: 'end' });
            };
        });
    };

    $scope.showTerminal = function (retry) {
        $scope.terminalVisible = true;

        reset();

        if (!$scope.selected) return;

        // we can only connect to apps here
        if ($scope.selected.type !== 'app') {
            var tmp = $('.logs-and-term-container');
            var logLine = $('<div class="log-line">');
            logLine.html('Terminal is only supported for apps, not for ' + $scope.selected.name);
            tmp.append(logLine);
            return;
        }

        $scope.terminal = new Terminal();
        $scope.terminal.open(document.querySelector('.logs-and-term-container'));
        $scope.terminal.fit();

        try {
            // websocket cannot use relative urls
            var url = Client.apiOrigin.replace('https', 'wss') + '/api/v1/apps/' + $scope.selected.value + '/execws?tty=true&rows=' + $scope.terminal.rows + '&columns=' + $scope.terminal.cols + '&access_token=' + Client.getToken();
            $scope.terminalSocket = new WebSocket(url);
            $scope.terminal.attach($scope.terminalSocket);

            $scope.terminalSocket.onclose = function () {
                // retry in one second only if terminal view is still selected
                setTimeout(function () {
                    if ($scope.terminalVisible) $scope.showTerminal(true);
                }, 1000);
            };
        } catch (e) {
            console.error(e);
        }

        if (retry) $scope.terminal.writeln('Reconnecting...');
        else $scope.terminal.writeln('Connecting...');
    };

    $scope.terminalInject = function (addon) {
        if (!$scope.terminalSocket) return;

        var cmd;
        if (addon === 'mysql') cmd = 'mysql --user=${MYSQL_USERNAME} --password=${MYSQL_PASSWORD} --host=${MYSQL_HOST} ${MYSQL_DATABASE}';
        else if (addon === 'postgresql') cmd = 'PGPASSWORD=${POSTGRESQL_PASSWORD} psql -h ${POSTGRESQL_HOST} -p ${POSTGRESQL_PORT} -U ${POSTGRESQL_USERNAME} -d ${POSTGRESQL_DATABASE}';
        else if (addon === 'mongodb') cmd = 'mongo -u "${MONGODB_USERNAME}" -p "${MONGODB_PASSWORD}" ${MONGODB_HOST}:${MONGODB_PORT}/${MONGODB_DATABASE}';
        else if (addon === 'redis') cmd = 'redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}"';

        if (!cmd) return;

        cmd += ' ';

        $scope.terminalSocket.send(cmd);
        $scope.terminal.focus();
    }

    $scope.uploadFile = function () {
        var fileUpload = document.querySelector('#fileUpload');

        fileUpload.oninput = function (e) {
            Client.uploadFile($scope.selected.value, e.target.files[0], function (error) {
                if (error) console.error(error);
            });
        };

        fileUpload.click();
    };

    $scope.$watch('selected', function (newVal) {
        if (!newVal) return;

        if ($scope.terminalVisible) $scope.showTerminal();
        else $scope.showLogs();
    });

    Client.onReady($scope.populateLogTypes);

    $scope.$on('$destroy', function () {
        if ($scope.activeEventSource) {
            $scope.activeEventSource.onmessage = function () {};
            $scope.activeEventSource.close();
            $scope.activeEventSource = null;
        }

        if ($scope.terminal) {
            $scope.terminal.destroy();
        }
    });

    // setup all the dialog focus handling
    ['downloadFileModal'].forEach(function (id) {
        $('#' + id).on('shown.bs.modal', function () {
            $(this).find("[autofocus]:first").focus();
        });
    });
}]);
