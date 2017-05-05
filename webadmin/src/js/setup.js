'use strict';

// create main application module
var app = angular.module('Application', ['angular-md5', 'ui-notification', 'ui.bootstrap']);

app.controller('SetupController', ['$scope', '$http', 'Client', function ($scope, $http, Client) {
    // Stupid angular location provider either wants html5 location mode or not, do the query parsing on my own
    var search = decodeURIComponent(window.location.search).slice(1).split('&').map(function (item) { return item.split('='); }).reduce(function (o, k) { o[k[0]] = k[1]; return o; }, {});

    $scope.initialized = false;
    $scope.busy = false;
    $scope.account = {
        email: '',
        displayName: '',
        requireEmail: false,
        username: '',
        password: ''
    };
    $scope.error = null;
    $scope.provider = '';
    $scope.apiServerOrigin = '';
    $scope.setupToken = '';

    $scope.activateCloudron = function () {
        $scope.busy = true;
        $scope.error = null;

        Client.createAdmin($scope.account.username, $scope.account.password, $scope.account.email, $scope.account.displayName, $scope.setupToken, function (error) {
            if (error && error.statusCode === 400) {
                $scope.busy = false;
                $scope.error = { username: error.message };
                $scope.account.username = '';
                $scope.setupForm.username.$setPristine();
                setTimeout(function () { $('#inputUsername').focus(); }, 200);
                return;
            } else if (error) {
                $scope.busy = false;
                console.error('Internal error', error);
                $scope.error = { generic: error.message };
                return;
            }

            window.location.href = '/';
        });
    };

    Client.getStatus(function (error, status) {
        if (error) {
            window.location.href = '/error.html';
            return;
        }

        // if we are here from the ip first go to the real domain if already setup
        if (status.provider !== 'caas' && status.adminFqdn && status.adminFqdn !== window.location.hostname) {
            window.location.href = 'https://' + status.adminFqdn + '/setup.html';
            return;
        }

        // if we don't have a domain yet, first go to domain setup
        if (!status.adminFqdn) {
            window.location.href = '/setupdns.html';
            return;
        }

        if (status.activated) {
            window.location.href = '/';
            return;
        }

        if (status.provider === 'caas') {
            if (!search.setupToken) {
                window.location.href = '/error.html?errorCode=2';
                return;
            }

            if (!search.email) {
                window.location.href = '/error.html?errorCode=3';
                return;
            }

            $scope.setupToken = search.setupToken;
        }

        $scope.account.email = search.email || $scope.account.email;
        $scope.account.displayName = search.displayName || $scope.account.displayName;
        $scope.account.requireEmail = !search.email;
        $scope.provider = status.provider;
        $scope.apiServerOrigin = status.apiServerOrigin;

        $scope.initialized = true;

        // Ensure we have a good autofocus
        setTimeout(function () {
            $(document).find("[autofocus]:first").focus();
        }, 250);
    });
}]);
