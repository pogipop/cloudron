'use strict';

/* global moment */

// create main application module
var app = angular.module('Application', ['angular-md5', 'ui-notification']);

app.controller('LogsController', ['$scope', '$timeout', '$location', 'Client', function ($scope, $timeout, $location, Client) {
    var search = decodeURIComponent(window.location.search).slice(1).split('&').map(function (item) { return item.split('='); }).reduce(function (o, k) { o[k[0]] = k[1]; return o; }, {});

    $scope.initialized = false;
    $scope.installedApps = Client.getInstalledApps();
    $scope.client = Client;
    $scope.logs = [];
    $scope.selected = '';
    $scope.activeEventSource = null;
    $scope.lines = 10;
    $scope.selectedAppInfo = null;

    // Add built-in log types for now
    $scope.logs.push({ name: 'System (All)', type: 'platform', value: 'all', url: Client.makeURL('/api/v1/cloudron/logs?units=all') });
    $scope.logs.push({ name: 'Box', type: 'platform', value: 'box', url: Client.makeURL('/api/v1/cloudron/logs?units=box') });
    $scope.logs.push({ name: 'Mail', type: 'platform', value: 'mail', url: Client.makeURL('/api/v1/cloudron/logs?units=mail') });

    $scope.error = function (error) {
        console.error(error);
        window.location.href = '/error.html';
    };

    function ab2str(buf) {
        return String.fromCharCode.apply(null, new Uint16Array(buf));
    }

    $scope.clear = function () {
        var logViewer = $('.logs-container');
        logViewer.empty();
    };

    function showLogs() {
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
                var tmp = $('.logs-container');
                var autoScroll = tmp[0].scrollTop > (tmp[0].scrollTopMax - 24);

                var logLine = $('<div class="log-line">');
                var timeString = moment.utc(data.realtimeTimestamp/1000).format('MMM DD HH:mm:ss');
                logLine.html('<span class="time">' + timeString + ' </span>' + window.ansiToHTML(typeof data.message === 'string' ? data.message : ab2str(data.message)));
                tmp.append(logLine);

                if (autoScroll) tmp[0].lastChild.scrollIntoView({ behavior: 'instant', block: 'end' });
            };
        });
    }

    Client.onApps(function () {
        if ($scope.selected.type !== 'app') return;

        var appId = $scope.selected.value;

        Client.getApp(appId, function (error, result) {
            if (error) return console.error(error);

            $scope.selectedAppInfo = result;
        });
    });

    Client.getStatus(function (error, status) {
        if (error) return $scope.error(error);

        if (!status.activated) {
            console.log('Not activated yet, redirecting', status);
            window.location.href = '/';
            return;
        }

        Client.refreshConfig(function (error) {
            if (error) return $scope.error(error);

            // check version and force reload if needed
            if (!localStorage.version) {
                localStorage.version = Client.getConfig().version;
            } else if (localStorage.version !== Client.getConfig().version) {
                localStorage.version = Client.getConfig().version;
                window.location.reload(true);
            }

            Client.refreshInstalledApps(function (error) {
                if (error) return $scope.error(error);

                Client.getInstalledApps().forEach(function (app) {
                    $scope.logs.push({
                        type: 'app',
                        value: app.id,
                        name: app.fqdn + ' (' + app.manifest.title + ')',
                        url: Client.makeURL('/api/v1/apps/' + app.id + '/logs'),
                        addons: app.manifest.addons
                    });
                });

                // activate pre-selected log from query otherwise choose the first one
                $scope.selected = $scope.logs.find(function (e) { return e.value === search.id; });
                if (!$scope.selected) $scope.selected = $scope.logs[0];

                // now mark the Client to be ready
                Client.setReady();

                $scope.initialized = true;

                showLogs();
            });
        });
    });
}]);
