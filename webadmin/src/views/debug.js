'use strict';

/* global moment */
/* global Terminal */

angular.module('Application').controller('DebugController', ['$scope', '$location', 'Client', function ($scope, $location, Client) {
    Client.onReady(function () { if (!Client.getUserInfo().admin) $location.path('/'); });

    $scope.config = Client.getConfig();
    $scope.user = Client.getUserInfo();

    $scope.logs = [];
    $scope.selected = '';
    $scope.activeEventSource = null;
    $scope.terminal = null;
    $scope.terminalSocket = null;
    $scope.lines = 10;
    $scope.terminalVisible = false;

    function ab2str(buf) {
        return String.fromCharCode.apply(null, new Uint16Array(buf));
    }

    $scope.populateLogTypes = function () {
        $scope.logs.push({ name: 'System (All)', type: 'platform', value: 'all', url: Client.makeURL('/api/v1/cloudron/logs?units=all') });
        $scope.logs.push({ name: 'Box', type: 'platform', value: 'box', url: Client.makeURL('/api/v1/cloudron/logs?units=box') });
        $scope.logs.push({ name: 'Mail', type: 'platform', value: 'mail', url: Client.makeURL('/api/v1/cloudron/logs?units=mail') });

        Client.getInstalledApps().forEach(function (app) {
            $scope.logs.push({ name: app.fqdn + ' (' + app.manifest.title + ')', type: 'app', value: app.id, url: Client.makeURL('/api/v1/apps/' + app.id + '/logs') });
        });

        $scope.selected = $scope.logs[0];
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

    $scope.showLogs = function () {
        $scope.terminalVisible = false;

        reset();

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

        // we can only connect to apps here
        if ($scope.selected.type !== 'app') {
            var tmp = $('.logs-and-term-container');
            var logLine = $('<div class="log-line">');
            logLine.html('Terminal is only supported for app, not for ' + $scope.selected.name);
            tmp.append(logLine);
            return;
        }

        $scope.terminal = new Terminal();

        try {
            // websocket cannot use relative urls
            var url = Client.apiOrigin.replace('https', 'wss') + '/api/v1/apps/' + $scope.selected.value + '/execws?tty=true';
            $scope.terminalSocket = new WebSocket(url);
            $scope.terminal.attach($scope.terminalSocket);

            $scope.terminalSocket.onclose = function () {
                // retry in one second
                setTimeout($scope.showTerminal.bind(null, true), 1000);
            };
        } catch (e) {
            console.error(e);
        }

        $scope.terminal.open(document.querySelector('.logs-and-term-container'));
        $scope.terminal.fit();

        if (retry) $scope.terminal.writeln('Reconnecting...');
        else $scope.terminal.writeln('Connecting...');
    };

    $scope.terminalInjectMysql = function () {
        if (!$scope.terminalSocket) return;

        $scope.terminalSocket.send('mysql --user=${MYSQL_USERNAME} --password=${MYSQL_PASSWORD} --host=${MYSQL_HOST} ${MYSQL_DATABASE}\n');
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
}]);
