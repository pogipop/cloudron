'use strict';

angular.module('Application').controller('LogsController', ['$scope', '$location', 'Client', function ($scope, $location, Client) {
    $scope.config = Client.getConfig();
    $scope.user = Client.getUserInfo();

    $scope.logs = {
        types: null,
        selectedUrl: '' // index into types
    };

    $scope.populateLogTypes = function () {
        $scope.logs.types = [
            { name: 'System (All)', url: Client.makeURL('/api/v1/cloudron/logs?units=all') },
            { name: 'Box', url: Client.makeURL('/api/v1/cloudron/logs?units=box') },
            { name: 'Mail', url: Client.makeURL('/api/v1/cloudron/logs?units=mail') }
        ];

        Client.getInstalledApps().forEach(function (app) {
            $scope.logs.types.push({ name: app.fqdn, url: Client.makeURL('/api/v1/apps/' + app.id + '/logs') });
        });
    };

    Client.onReady($scope.populateLogTypes);
}]);
