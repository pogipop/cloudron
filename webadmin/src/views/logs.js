'use strict';

angular.module('Application').controller('LogsController', ['$scope', '$location', 'Client', function ($scope, $location, Client) {
    $scope.config = Client.getConfig();
    $scope.user = Client.getUserInfo();

    $scope.logs = [];
    $scope.selected = '';
    $scope.activeEventSource = null;

    function ab2str(buf) {
        return String.fromCharCode.apply(null, new Uint16Array(buf));
    }

    $scope.populateLogTypes = function () {
        $scope.logs.push({ name: 'System (All)', type: 'platform', value: 'all', url: Client.makeURL('/api/v1/cloudron/logs?units=all') });
        $scope.logs.push({ name: 'Box', type: 'platform', value: 'box', url: Client.makeURL('/api/v1/cloudron/logs?units=box') });
        $scope.logs.push({ name: 'Mail', type: 'platform', value: 'mail', url: Client.makeURL('/api/v1/cloudron/logs?units=mail') });

        Client.getInstalledApps().forEach(function (app) {
            $scope.logs.push({ name: app.fqdn, type: 'app', value: app.id, url: Client.makeURL('/api/v1/apps/' + app.id + '/logs') });
        });

        $scope.selected = $scope.logs[0];
    };

    $scope.$watch('selected', function (newVal) {
        if (!newVal) return;

        // close the old event source so we wont receive any new logs
        if ($scope.activeEventSource) {
            $scope.activeEventSource.close();
            $scope.activeEventSource = null;
        }

        var func = newVal.type === 'platform' ? Client.getPlatformLogs : Client.getAppLogs;
        func(newVal.value, true, function handleLogs(error, result) {
            if (error) return console.error(error);

            var logViewer = $('.log-line-container');
            logViewer.empty();

            $scope.activeEventSource = result;
            result.onmessage = function handleMessage(message) {
                var data;

                try {
                    data = JSON.parse(message.data);
                } catch (e) {
                    return console.error(e);
                }

                var logLine = $('<div>');
                logLine.html(window.ansiToHTML(ab2str(data.message)));
                logViewer.append(logLine);
            };
        });
    });

    Client.onReady($scope.populateLogTypes);
}]);
