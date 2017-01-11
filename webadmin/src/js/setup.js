'use strict';

// create main application module
var app = angular.module('Application', ['angular-md5', 'ui-notification']);

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
    $scope.createAppstoreAccount = true;

    $scope.activateCloudron = function () {
        $scope.busy = true;

        function registerAppstoreAccountIfNeeded(callback) {
            if (!$scope.createAppstoreAccount) return callback(null);
            if ($scope.provider === 'caas') return callback(null);

            $http.post($scope.apiServerOrigin + '/api/v1/users', { email: $scope.account.email, password: $scope.account.password }).success(function (data, status) {
                if (status !== 201) return callback({ status: status, data: data });

                Client.setAppstoreConfig({ userId: data.userId, token: data.accessToken }, callback);
            }).error(function (data, status) {
                callback({ status: status, data: data });
            });
        }

        Client.createAdmin($scope.account.username, $scope.account.password, $scope.account.email, $scope.account.displayName, $scope.setupToken, function (error) {
            if (error) {
                console.error('Internal error', error);
                $scope.error = error;
                $scope.busy = false;
                return;
            }

            registerAppstoreAccountIfNeeded(function (error) {
                if (error) console.error('Unable to create appstore account.', error);  // this is not fatal

                window.location.href = '/';
            });
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

        if (status.activated) {
            window.location.href = '/';
            return;
        }

        // if we don't have a domain yet, first go to domain setup
        if (!status.adminFqdn) {
            window.location.href = '/setupdns.html';
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
            $scope.createAppstoreAccount = false;
        }

        $scope.account.email = search.email || $scope.account.email;
        $scope.account.displayName = search.displayName || $scope.account.displayName;
        $scope.account.requireEmail = !search.email;
        $scope.provider = status.provider;
        $scope.apiServerOrigin = status.apiServerOrigin;

        $scope.initialized = true;
    });
}]);
