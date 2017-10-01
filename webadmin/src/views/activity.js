'use strict';

angular.module('Application').controller('ActivityController', ['$scope', '$location', 'Client', function ($scope, $location, Client) {
    $scope.config = Client.getConfig();

    $scope.busy = false;
    $scope.eventLogs = [ ];

    // TODO sync this with the eventlog filter
    $scope.actions = [
        { name: 'cloudron.activate', value: 'cloudron.activate' },
        { name: 'app.configure', value: 'app.configure' },
        { name: 'app.install', value: 'app.install' },
        { name: 'app.restore', value: 'app.restore' },
        { name: 'app.uninstall', value: 'app.uninstall' },
        { name: 'app.update', value: 'app.update' },
        { name: 'app.login', value: 'app.login' },
        { name: 'backup.cleanup', value: 'backup.cleanup' },
        { name: 'backup.finish', value: 'backup.finish' },
        { name: 'backup.start', value: 'backup.start' },
        { name: 'certificate.renew', value: 'certificate.renew' },
        { name: 'settings.climode', value: 'settings.climode' },
        { name: 'cloudron.start', value: 'cloudron.start' },
        { name: 'cloudron.update', value: 'cloudron.update' },
        { name: 'user.add', value: 'user.add' },
        { name: 'user.login', value: 'user.login' },
        { name: 'user.remove', value: 'user.remove' },
        { name: 'user.update', value: 'user.update' }
    ];

    $scope.pageItemCount = [
        { name: 'Show 20 per page', value: 20 },
        { name: 'Show 50 per page', value: 50 },
        { name: 'Show 100 per page', value: 100 }
    ];

    $scope.currentPage = 1;
    $scope.pageItems = $scope.pageItemCount[0];
    $scope.action = '';
    $scope.search = '';

    function fetchEventLogs() {
        $scope.busy = true;

        Client.getEventLogs($scope.action ? $scope.action.value : null, $scope.search || null, $scope.currentPage, $scope.pageItems.value, function (error, eventLogs) {
            $scope.busy = false;

            if (error) return console.error(error);

            $scope.eventLogs = eventLogs;
        });
    }

    $scope.showNextPage = function () {
        $scope.currentPage++;
        fetchEventLogs();
    };

    $scope.showPrevPage = function () {
        if ($scope.currentPage > 1) $scope.currentPage--;
        else $scope.currentPage = 1;

        fetchEventLogs();
    };

    $scope.updateFilter = function (fresh) {
        if (fresh) $scope.currentPage = 1;
        fetchEventLogs();
    };

    Client.onReady(function () {
        fetchEventLogs();
    });

    $('.modal-backdrop').remove();
}]);
