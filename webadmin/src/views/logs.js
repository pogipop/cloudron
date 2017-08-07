'use strict';

angular.module('Application').controller('LogsController', ['$scope', '$location', 'Client', function ($scope, $location, Client) {
    $scope.config = Client.getConfig();
    $scope.user = Client.getUserInfo();

    $scope.logs = [];
    $scope.selected = null;

    function ab2str(buf) {
        return String.fromCharCode.apply(null, new Uint16Array(buf));
    }

    $scope.populateLogTypes = function () {
        $scope.logs.push({ name: 'System (All)', type: 'platform', units: 'all' });
        $scope.logs.push({ name: 'Box', type: 'platform', units: 'box' });
        $scope.logs.push({ name: 'Mail', type: 'platform', units: 'mail' });

        Client.getInstalledApps().forEach(function (app) {
            $scope.logs.types.push({ name: app.fqdn, type: 'app', id: app.id });
        });
    };

    $scope.$watch('selected', function (newVal) {
        if (!newVal) return;

        if (newVal.type === 'platform') {
            Client.getPlatformLogs(newVal.units, true, function (error, result) {
                if (error) return console.error(error);

                var logViewer = $('.log-line-container');
                logViewer.empty();
            });
        } else {
            Client.getAppLogs(newVal.id, true, function (error, result) {
                if (error) return console.error(error);

                var logViewer = $('.log-line-container');
                logViewer.empty();

                result.onmessage = function (e) {
                    var data;

                    try {
                        data = JSON.parse(e.data);
                    } catch (e) {
                        return console.error(e);
                    }

                    var logLine = $('<div>');
                    logLine.html(window.ansiToHTML(ab2str(data.message)));
                    logViewer.append(logLine);
                };
            });
        }
    });

    Client.onReady($scope.populateLogTypes);
}]);
