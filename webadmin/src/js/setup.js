'use strict';

// create main application module
var app = angular.module('Application', ['angular-md5', 'ui-notification']);

app.directive('ngEnter', function () {
    return function (scope, element, attrs) {
        element.bind('keydown keypress', function (event) {
            if(event.which === 13) {
                scope.$apply(function (){
                    scope.$eval(attrs.ngEnter);
                });

                event.preventDefault();
            }
        });
    };
});

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

    $scope.showDNSSetup = false;
    $scope.dnsProvider = [
        { name: 'Manual/Wildcard', value: 'manual' },
        { name: 'Wildcard', value: 'wildcard' },
        { name: 'No-op', value: 'noop' },
        { name: 'AWS Route53', value: 'route53' },
        { name: 'Digital Ocean', value: 'digitalocean' }
    ];
    $scope.dnsCredentials = {
        error: null,
        busy: false,
        domain: '',
        accessKeyId: '',
        secretAccessKey: '',
        digitalOceanToken: '',
        provider: 'route53'
    };

    $scope.activateCloudron = function () {
        $scope.busy = true;

        function registerAppstoreAccountIfNeeded(callback) {
            if (!$scope.createAppstoreAccount) return callback(null);

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

            // for caas we are done here
            if ($scope.provider === 'caas') {
                window.location.href = '/';
                return;
            }

            registerAppstoreAccountIfNeeded(function (error) {
                if (error) console.error('Unable to create appstore account.', error);  // this is not fatal

                $scope.busy = false;
                $scope.showDNSSetup = true;
            });
        });
    };

    $scope.setDNSCredentials = function () {
        $scope.busy = true;

        var data = {
            domain: $scope.dnsCredentials.domain,
            provider: $scope.dnsCredentials.provider,
            accessKeyId: $scope.dnsCredentials.accessKeyId,
            secretAccessKey: $scope.dnsCredentials.secretAccessKey,
            token: $scope.dnsCredentials.digitalOceanToken
        };

        // special case the wildcard provider
        if (data.provider === 'wildcard') {
            data.provider = 'manual';
            data.wildcard = true;
        }

        Client.setDnsConfig(data, function (error) {
            if (error) {
                $scope.busy = false;
                $scope.dnsCredentials.error = error.message;
                return;
            }

            setTimeout(function () {
                // TODO wait until domain is propagated and cert got acquired
                window.location.href = 'https://my.' + $scope.dnsCredentials.domain;
            }, 5000);
        });
    };

    Client.getStatus(function (error, status) {
        if (error) {
            window.location.href = '/error.html';
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
