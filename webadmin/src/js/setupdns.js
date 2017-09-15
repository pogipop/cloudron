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
        { name: 'Cloudflare (DNS only)', value: 'cloudflare' },
        { name: 'Digital Ocean', value: 'digitalocean' },
        { name: 'Google Cloud DNS', value: 'gcdns' },
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
        gcdnsKey: { keyFileName: '', content: '' },
        digitalOceanToken: '',
        provider: 'route53'
    };

    function readFileLocally(obj, file, fileName) {
        return function (event) {
            $scope.$apply(function () {
                obj[file] = null;
                obj[fileName] = event.target.files[0].name;

                var reader = new FileReader();
                reader.onload = function (result) {
                    if (!result.target || !result.target.result) return console.error('Unable to read local file');
                    obj[file] = result.target.result;
                };
                reader.readAsText(event.target.files[0]);
            });
        };
    }

    document.getElementById('gcdnsKeyFileInput').onchange = readFileLocally($scope.dnsCredentials.gcdnsKey, 'content', 'keyFileName');

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
        } else if (data.provider === 'gcdns'){
            try {
                var serviceAccountKey = JSON.parse($scope.dnsCredentials.gcdnsKey.content);
                data.projectId = serviceAccountKey.project_id;
                data.credentials = {
                    client_email: serviceAccountKey.client_email,
                    private_key: serviceAccountKey.private_key
                };

                if (!data.projectId || !data.credentials || !data.credentials.client_email || !data.credentials.private_key) {
                    throw "fields_missing";
                }
            } catch(e) {
                $scope.dnsCredentials.error = "Cannot parse Google Service Account Key";
                $scope.dnsCredentials.busy = false;
                return;
            }
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
            // webadminStatus.dns is intentionally not tested. it can be false if dns creds are invalid
            // runConfigurationChecks() in main.js will pick the .dns and show a notification
            if (!error && status.adminFqdn && status.webadminStatus.tls) {
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
        if (status.provider === 'gcp') $scope.dnsCredentials.provider = 'gcdns';
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
