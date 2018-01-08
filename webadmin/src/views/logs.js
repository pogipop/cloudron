'use strict';

/* global moment */

angular.module('Application').controller('LogsController', ['$scope', '$location', '$route', '$routeParams', 'Client', function ($scope, $location, $route, $routeParams, Client) {
    Client.onReady(function () { if (!Client.getUserInfo().admin) $location.path('/'); });

    $scope.config = Client.getConfig();
    $scope.user = Client.getUserInfo();

    $scope.logs = [];
    $scope.selected = '';
    $scope.activeEventSource = null;
    $scope.lines = 10;
    $scope.selectedAppInfo = null;

    function ab2str(buf) {
        return String.fromCharCode.apply(null, new Uint16Array(buf));
    }

    $scope.populateLogTypes = function () {
        $scope.logs.push({ name: 'System (All)', type: 'platform', value: 'all', url: Client.makeURL('/api/v1/cloudron/logs?units=all') });
        $scope.logs.push({ name: 'Box', type: 'platform', value: 'box', url: Client.makeURL('/api/v1/cloudron/logs?units=box') });
        $scope.logs.push({ name: 'Mail', type: 'platform', value: 'mail', url: Client.makeURL('/api/v1/cloudron/logs?units=mail') });

        Client.getInstalledApps().sort(function (app1, app2) { return app1.fqdn.localeCompare(app2.fqdn); }).forEach(function (app) {
            $scope.logs.push({
                type: 'app',
                value: app.id,
                name: app.fqdn + ' (' + app.manifest.title + ')',
                url: Client.makeURL('/api/v1/apps/' + app.id + '/logs'),
                addons: app.manifest.addons
            });
        });

        // activate pre-selected log from query
        $scope.selected = $scope.logs.find(function (e) { return e.value === $routeParams.id; });

        if (!$scope.selected) {
            $scope.selected = $scope.logs[0];
        }
    };

    function reset() {
        // close the old event source so we wont receive any new logs
        if ($scope.activeEventSource) {
            $scope.activeEventSource.close();
            $scope.activeEventSource = null;
        }

        var logViewer = $('.logs-container');
        logViewer.empty();

        $scope.selectedAppInfo = null;
    }

    $scope.showLogs = function () {
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
                var tmp = $('.logs-container');
                var autoScroll = tmp[0].scrollTop > (tmp[0].scrollTopMax - 24);

                var logLine = $('<div class="log-line">');
                var timeString = moment.utc(data.realtimeTimestamp/1000).format('MMM DD HH:mm:ss');
                logLine.html('<span class="time">' + timeString + ' </span>' + window.ansiToHTML(typeof data.message === 'string' ? data.message : ab2str(data.message)));
                tmp.append(logLine);

                if (autoScroll) tmp[0].lastChild.scrollIntoView({ behavior: 'instant', block: 'end' });
            };
        });
    };

    $scope.$watch('selected', function (newVal) {
        if (!newVal) return;

        $route.updateParams({ id: newVal.value });
        $scope.showLogs();
    });

    Client.onReady($scope.populateLogTypes);

    Client.onApps(function () {
        if ($scope.$$destroyed) return;
        if ($scope.selected.type !== 'app') return;

        var appId = $scope.selected.value;

        Client.getApp(appId, function (error, result) {
            if (error) return console.error(error);

            $scope.selectedAppInfo = result;
        });
    });

    $scope.$on('$destroy', function () {
        if ($scope.activeEventSource) {
            $scope.activeEventSource.onmessage = function () {};
            $scope.activeEventSource.close();
            $scope.activeEventSource = null;
        }
    });
}]);
