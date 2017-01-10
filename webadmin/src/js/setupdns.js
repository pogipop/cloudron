'use strict';

// create main application module
var app = angular.module('Application', ['angular-md5', 'ui-notification']);

app.controller('SetupDNSController', ['$scope', '$http', 'Client', function ($scope, $http, Client) {
    $scope.initialized = false;
    $scope.busy = false;
    $scope.error = null;
    $scope.provider = '';
    $scope.showDNSSetup = false;
    // keep in sync with certs.js
    $scope.dnsProvider = [
        { name: 'AWS Route53', value: 'route53' },
        { name: 'Digital Ocean', value: 'digitalocean' },
        { name: 'Wildcard', value: 'wildcard' },
        { name: 'Manual (not recommended)', value: 'manual' },
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

            waitForDnsSetup();
       });
    };

    function waitForDnsSetup() {
        $scope.busy = true;

        Client.getStatus(function (error, status) {
            if (!error && status.configState.domain && status.configState.dns && status.configState.tls) {
                window.location.href = 'https://my.' + status.configState.domain + '/setup.html';
            }

            setTimeout(waitForDnsSetup, 5000);
        });
    }

    Client.getStatus(function (error, status) {
        if (error) {
            window.location.href = '/error.html';
            return;
        }

        // domain is currently like a lock flag
        if (status.configState.domain) return waitForDnsSetup();

        if (status.provider === 'digitalocean') $scope.dnsCredentials.provider = 'digitalocean';

        $scope.provider = status.provider;
        $scope.initialized = true;
    });
}]);
