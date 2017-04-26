'use strict';

/* global tld */

// create main application module
var app = angular.module('Application', ['angular-md5', 'ui-notification']);

app.filter('zoneName', function () {
    return function (domain) {
        return tld.getDomain(domain);
    };
});

app.controller('SetupDNSController', ['$scope', '$http', 'Client', function ($scope, $http, Client) {
    var search = decodeURIComponent(window.location.search).slice(1).split('&').map(function (item) { return item.split('='); }).reduce(function (o, k) { o[k[0]] = k[1]; return o; }, {});

    $scope.initialized = false;
    $scope.busy = false;
    $scope.error = null;
    $scope.provider = '';
    $scope.showDNSSetup = false;
    $scope.instanceId = '';
    $scope.explicitZone = search.zone || '';
    $scope.isDomain = false;
    $scope.isSubdomain = false;

    $scope.$watch('dnsCredentials.domain', function (newVal) {
        if (!newVal) {
            $scope.isDomain = false;
            $scope.isSubdomain = false;
        } else if (!tld.getDomain(newVal) || newVal[newVal.length-1] === '.') {
            $scope.isDomain = false;
            $scope.isSubdomain = false;
        } else {
            $scope.isDomain = true;
            $scope.isSubdomain = tld.getDomain(newVal) !== newVal;
        }
    });

    // keep in sync with certs.js
    $scope.dnsProvider = [
        { name: 'AWS Route53', value: 'route53' },
        { name: 'Digital Ocean', value: 'digitalocean' },
        { name: 'Cloudflare', value: 'cloudflare' },
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
        $scope.dnsCredentials.error = null;
        $scope.error = null;

        var data = {
            domain: $scope.dnsCredentials.domain,
            zoneName: $scope.explicitZone,
            provider: $scope.dnsCredentials.provider,
            providerToken: $scope.instanceId
        };

        // special case the wildcard provider
        if (data.provider === 'wildcard') {
            data.provider = 'manual';
            data.wildcard = true;
        }

        if (data.provider === 'route53') {
            data.accessKeyId = $scope.dnsCredentials.accessKeyId;
            data.secretAccessKey = $scope.dnsCredentials.secretAccessKey;
        } else if (data.provider === 'digitalocean') {
            data.token = $scope.dnsCredentials.digitalOceanToken;
        } else if (data.provider === 'cloudflare') {
            data.email = $scope.dnsCredentials.cloudflareEmail;
            data.token = $scope.dnsCredentials.cloudflareToken;
        }

        Client.setupDnsConfig(data, function (error) {
            if (error && error.statusCode === 403) {
                $scope.dnsCredentials.busy = false;
                $scope.error = 'Wrong instance id provided.';
                return;
            } else if (error) {
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
            if (!error && status.adminFqdn && status.webadminStatus.dns && status.webadminStatus.tls) {
                window.location.href = 'https://' + status.adminFqdn + '/setup.html';
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
        if (status.adminFqdn) return waitForDnsSetup();

        if (status.provider === 'digitalocean') $scope.dnsCredentials.provider = 'digitalocean';
        if (status.provider === 'ami') {
            // remove route53 on ami
            $scope.dnsProvider.shift();
            $scope.dnsCredentials.provider = 'wildcard';
        }

        $scope.instanceId = search.instanceId;
        $scope.provider = status.provider;
        $scope.initialized = true;
    });
}]);
