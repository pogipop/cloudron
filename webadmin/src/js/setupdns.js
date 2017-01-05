'use strict';

// create main application module
var app = angular.module('Application', ['angular-md5', 'ui-notification']);

app.controller('SetupDNSController', ['$scope', '$http', 'Client', function ($scope, $http, Client) {
    $scope.initialized = false;
    $scope.busy = false;
    $scope.error = null;
    $scope.provider = '';
    $scope.showDNSSetup = false;
    $scope.dnsProvider = [
        { name: 'AWS Route53', value: 'route53' },
        { name: 'Digital Ocean', value: 'digitalocean' },
        { name: 'Manual', value: 'manual' },
        { name: 'Wildcard', value: 'wildcard' },
        { name: 'No-op (only for development)', value: 'noop' }
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

    $scope.setDnsCredentials = function () {
        $scope.dnsCredentials.busy = true;

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

        Client.setupDnsConfig(data, function (error) {
            if (error) {
                $scope.dnsCredentials.busy = false;
                $scope.dnsCredentials.error = error.message;
                return;
            }

            $scope.busy = true;

            setTimeout(function () {
                // TODO wait until domain is propagated and cert got acquired
                window.location.href = 'https://my.' + $scope.dnsCredentials.domain + '/setup.html';
            }, 5000);
        });
    };

    Client.getStatus(function (error, status) {
        if (error) {
            window.location.href = '/error.html';
            return;
        }

        if (status.activated || status.provider === 'caas') {
            window.location.href = '/';
            return;
        }

        $scope.provider = status.provider;
        $scope.initialized = true;
    });
}]);
