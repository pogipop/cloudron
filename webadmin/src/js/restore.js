'use strict';

/* global tld */

// create main application module
var app = angular.module('Application', ['angular-md5', 'ui-notification']);

app.filter('zoneName', function () {
    return function (domain) {
        return tld.getDomain(domain);
    };
});

app.controller('RestoreController', ['$scope', '$http', 'Client', function ($scope, $http, Client) {
    var search = decodeURIComponent(window.location.search).slice(1).split('&').map(function (item) { return item.split('='); }).reduce(function (o, k) { o[k[0]] = k[1]; return o; }, {});

    $scope.busy = false;
    $scope.error = {};
    $scope.provider = '';
    $scope.bucket = '';
    $scope.prefix = '';
    $scope.accessKeyId = '';
    $scope.secretAccessKey = '';
    $scope.region = '';
    $scope.endpoint = '';
    $scope.backupFolder = '';
    $scope.backupId = '';
    $scope.instanceId = '';
    $scope.acceptSelfSignedCerts = false;
    $scope.format = 'tgz';

    // List is from http://docs.aws.amazon.com/general/latest/gr/rande.html#s3_region
    $scope.s3Regions = [
        { name: 'Asia Pacific (Mumbai)', value: 'ap-south-1' },
        { name: 'Asia Pacific (Seoul)', value: 'ap-northeast-2' },
        { name: 'Asia Pacific (Singapore)', value: 'ap-southeast-1' },
        { name: 'Asia Pacific (Sydney)', value: 'ap-southeast-2' },
        { name: 'Asia Pacific (Tokyo)', value: 'ap-northeast-1' },
        { name: 'Canada (Central)', value: 'ca-central-1' },
        { name: 'EU (Frankfurt)', value: 'eu-central-1' },
        { name: 'EU (Ireland)', value: 'eu-west-1' },
        { name: 'EU (London)', value: 'eu-west-2' },
        { name: 'South America (São Paulo)', value: 'sa-east-1' },
        { name: 'US East (N. Virginia)', value: 'us-east-1' },
        { name: 'US East (Ohio)', value: 'us-east-2' },
        { name: 'US West (N. California)', value: 'us-west-1' },
        { name: 'US West (Oregon)', value: 'us-west-2' },
    ];

    $scope.doSpacesRegions = [
        { name: 'AMS3', value: 'https://ams3.digitaloceanspaces.com' },
        { name: 'NYC3', value: 'https://nyc3.digitaloceanspaces.com' }
    ];

    $scope.storageProvider = [
        { name: 'Amazon S3', value: 's3' },
        { name: 'DigitalOcean Spaces', value: 'digitalocean-spaces' },
        { name: 'Exoscale SOS', value: 'exoscale-sos' },
        { name: 'Filesystem', value: 'filesystem' },
        { name: 'Minio', value: 'minio' },
        { name: 'S3 API Compatible (v4)', value: 's3-v4-compat' },
    ];

    $scope.formats = [
        { name: 'Tarball (zipped)', value: 'tgz' },
        { name: 'rsync', value: 'rsync' }
    ];

    $scope.s3like = function (provider) {
        return provider === 's3' || provider === 'minio' || provider === 's3-v4-compat' || provider === 'exoscale-sos' || provider === 'digitalocean-spaces';
    };

    $scope.restore = function () {
        $scope.error = {};
        $scope.busy = true;

        var backupConfig = {
            provider: $scope.provider,
            key: $scope.key,
            format: $scope.format
        };

        // only set provider specific fields, this will clear them in the db
        if ($scope.s3like(backupConfig.provider)) {
            backupConfig.bucket = $scope.bucket;
            backupConfig.prefix = $scope.prefix;
            backupConfig.accessKeyId = $scope.accessKeyId;
            backupConfig.secretAccessKey = $scope.secretAccessKey;

            if ($scope.endpoint) backupConfig.endpoint = $scope.endpoint;

            if (backupConfig.provider === 's3') {
                if ($scope.region) backupConfig.region = $scope.region;
            } else if (backupConfig.provider === 'minio' || backupConfig.provider === 's3-v4-compat') {
                backupConfig.region = 'us-east-1';
                backupConfig.acceptSelfSignedCerts = $scope.acceptSelfSignedCerts;
            } else if (backupConfig.provider === 'exoscale-sos') {
                backupConfig.endpoint = 'https://sos.exo.io';
                backupConfig.region = 'us-east-1';
                backupConfig.signatureVersion = 'v2';
            } else if (backupConfig.provider === 'digitalocean-spaces') {
                backupConfig.region = 'us-east-1';
            }
        } else if (backupConfig.provider === 'filesystem') {
            backupConfig.backupFolder = $scope.backupFolder;
        }

        var version = $scope.backupId.match(/_v(\d+.\d+.\d+)/);
        Client.restore(backupConfig, $scope.backupId.replace(/\.tar\.gz(\.enc)?$/, ''), version ? version[1] : '', function (error) {
            $scope.busy = false;

            if (error) {
                if (error.statusCode === 402) {
                    $scope.error.generic = error.message;

                    if (error.message.indexOf('AWS Access Key Id') !== -1) {
                        $scope.error.accessKeyId = true;
                        $scope.accessKeyId = '';
                        $scope.configureBackupForm.accessKeyId.$setPristine();
                        $('#inputConfigureBackupAccessKeyId').focus();
                    } else if (error.message.indexOf('not match the signature') !== -1 ) {
                        $scope.error.secretAccessKey = true;
                        $scope.secretAccessKey = '';
                        $scope.configureBackupForm.secretAccessKey.$setPristine();
                        $('#inputConfigureBackupSecretAccessKey').focus();
                    } else if (error.message.toLowerCase() === 'access denied') {
                        $scope.error.bucket = true;
                        $scope.bucket = '';
                        $scope.configureBackupForm.bucket.$setPristine();
                        $('#inputConfigureBackupBucket').focus();
                    } else if (error.message.indexOf('ECONNREFUSED') !== -1) {
                        $scope.error.generic = 'Unknown region';
                        $scope.error.region = true;
                        $scope.configureBackupForm.region.$setPristine();
                        $('#inputConfigureBackupRegion').focus();
                    } else if (error.message.toLowerCase() === 'wrong region') {
                        $scope.error.generic = 'Wrong S3 Region';
                        $scope.error.region = true;
                        $scope.configureBackupForm.region.$setPristine();
                        $('#inputConfigureBackupRegion').focus();
                    } else {
                        $('#inputConfigureBackupBucket').focus();
                    }
                } else {
                    $scope.error.generic = error.message;
                }

                return;
            }

            waitForRestore();
        });
    }

    function waitForRestore() {
        $scope.busy = true;

        Client.getStatus(function (error, status) {
            if (!error && !status.restoring) {
                window.location.href = '/';
            }

            setTimeout(waitForRestore, 5000);
        });
    }

    Client.getStatus(function (error, status) {
        if (error) {
            window.location.href = '/error.html';
            return;
        }

        if (status.restoring) return waitForRestore();

        if (status.activated) {
            window.location.href = '/';
            return;
        }

        $scope.instanceId = search.instanceId;
        $scope.initialized = true;
    });
}]);
