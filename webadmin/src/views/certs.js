'use strict';

angular.module('Application').controller('CertsController', ['$scope', '$location', 'Client', 'ngTld', function ($scope, $location, Client, ngTld) {
    Client.onReady(function () { if (!Client.getUserInfo().admin) $location.path('/'); });

    $scope.config = Client.getConfig();
    $scope.dnsConfig = null;

    // keep in sync with setupdns.js
    $scope.dnsProvider = [
        { name: 'AWS Route53', value: 'route53' },
        { name: 'Google Cloud DNS', value: 'gcdns' },
        { name: 'Digital Ocean', value: 'digitalocean' },
        { name: 'Cloudflare (DNS only)', value: 'cloudflare' },
        { name: 'Wildcard', value: 'wildcard' },
        { name: 'Manual (not recommended)', value: 'manual' },
        { name: 'No-op (only for development)', value: 'noop' }
    ];

    $scope.defaultCert = {
        error: null,
        success: false,
        busy: false,
        certificateFile: null,
        certificateFileName: '',
        keyFile: null,
        keyFileName: ''
    };

    $scope.adminCert = {
        error: null,
        success: false,
        busy: false,
        certificateFile: null,
        certificateFileName: '',
        keyFile: null,
        keyFileName: ''
    };

    $scope.dnsCredentials = {
        error: null,
        success: false,
        busy: false,
        customDomain: '',
        accessKeyId: '',
        secretAccessKey: '',
        gcdnsKey: {keyFileName: "", content: ""},
        digitalOceanToken: '',
        cloudflareToken: '',
        cloudflareEmail: '',
        provider: 'route53',
        password: ''
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

    document.getElementById('defaultCertFileInput').onchange = readFileLocally($scope.defaultCert, 'certificateFile', 'certificateFileName');
    document.getElementById('defaultKeyFileInput').onchange = readFileLocally($scope.defaultCert, 'keyFile', 'keyFileName');
    document.getElementById('adminCertFileInput').onchange = readFileLocally($scope.adminCert, 'certificateFile', 'certificateFileName');
    document.getElementById('adminKeyFileInput').onchange = readFileLocally($scope.adminCert, 'keyFile', 'keyFileName');

    document.getElementById('gcdnsKeyFileInput').onchange = readFileLocally($scope.dnsCredentials.gcdnsKey, 'content', 'keyFileName');

    $scope.setDefaultCert = function () {
        $scope.defaultCert.busy = true;
        $scope.defaultCert.error = null;
        $scope.defaultCert.success = false;

        Client.setCertificate($scope.defaultCert.certificateFile, $scope.defaultCert.keyFile, function (error) {
            if (error) {
                $scope.defaultCert.error = error.message;
            } else {
                $scope.defaultCert.success = true;
                $scope.defaultCert.certificateFileName = '';
                $scope.defaultCert.keyFileName = '';
            }

            $scope.defaultCert.busy = false;
        });
    };

    $scope.setAdminCert = function () {
        $scope.adminCert.busy = true;
        $scope.adminCert.error = null;
        $scope.adminCert.success = false;

        Client.setAdminCertificate($scope.adminCert.certificateFile, $scope.adminCert.keyFile, function (error) {
            if (error) {
                $scope.adminCert.error = error.message;
            } else {
                $scope.adminCert.success = true;
                $scope.adminCert.certificateFileName = '';
                $scope.adminCert.keyFileName = '';
            }

            $scope.adminCert.busy = false;

            // attempt to reload to make the browser get the new certs
            window.location.reload(true);
        });
    };

    $scope.setDnsCredentials = function () {
        $scope.dnsCredentials.busy = true;
        $scope.dnsCredentials.error = null;
        $scope.dnsCredentials.success = false;

        var migrateDomain = $scope.dnsCredentials.customDomain !== $scope.config.fqdn;

        var data = {
            provider: $scope.dnsCredentials.provider
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
            data.token = $scope.dnsCredentials.cloudflareToken;
            data.email = $scope.dnsCredentials.cloudflareEmail;
        }

        var func;
        if (migrateDomain) {
            data.domain = $scope.dnsCredentials.customDomain;
            func = Client.migrate.bind(Client, data, $scope.dnsCredentials.password);
        } else {
            func = Client.setDnsConfig.bind(Client, data);
        }

        func(function (error) {
            if (error) {
                $scope.dnsCredentials.error = error.message;
            } else {
                $scope.dnsCredentials.success = true;

                $('#dnsCredentialsModal').modal('hide');

                dnsCredentialsReset();

                if (migrateDomain) window.location.href = '/update.html';
            }

            $scope.dnsCredentials.busy = false;

            // reload the dns config
            Client.getDnsConfig(function (error, result) {
                if (error) return console.error(error);

                $scope.dnsConfig = result;
            });
        });
    };

    function dnsCredentialsReset() {
        $scope.dnsCredentials.busy = false;
        $scope.dnsCredentials.success = false;
        $scope.dnsCredentials.error = null;

        $scope.dnsCredentials.provider = '';
        $scope.dnsCredentials.customDomain = '';
        $scope.dnsCredentials.accessKeyId = '';
        $scope.dnsCredentials.secretAccessKey = '';
        $scope.dnsCredentials.gcdnsKey.keyFileName = '';
        $scope.dnsCredentials.gcdnsKey.content = '';
        $scope.dnsCredentials.digitalOceanToken = '';
        $scope.dnsCredentials.cloudflareToken = '';
        $scope.dnsCredentials.cloudflareEmail = '';
        $scope.dnsCredentials.password = '';

        $scope.dnsCredentialsForm.$setPristine();
        $scope.dnsCredentialsForm.$setUntouched();

        $('#customDomainId').focus();
    }

    $scope.showChangeDnsCredentials = function () {
        dnsCredentialsReset();

        // clear the input box for non-custom domain
        $scope.dnsCredentials.customDomain = $scope.config.isCustomDomain ? $scope.config.fqdn : '';
        $scope.dnsCredentials.accessKeyId = $scope.dnsConfig.accessKeyId;
        $scope.dnsCredentials.secretAccessKey = $scope.dnsConfig.secretAccessKey;

        $scope.dnsCredentials.gcdnsKey.keyFileName = '';
        $scope.dnsCredentials.gcdnsKey.content = '';
        if($scope.dnsConfig.provider === 'gcdns'){
            $scope.dnsCredentials.gcdnsKey.keyFileName = $scope.dnsConfig.credentials.client_email;
            $scope.dnsCredentials.gcdnsKey.content = JSON.stringify({
                "project_id": $scope.dnsConfig.projectId,
                "credentials": $scope.dnsConfig.credentials
            });
        }
        $scope.dnsCredentials.digitalOceanToken = $scope.dnsConfig.provider === 'digitalocean' ? $scope.dnsConfig.token : '';
        $scope.dnsCredentials.cloudflareToken = $scope.dnsConfig.provider === 'cloudflare' ? $scope.dnsConfig.token : '';
        $scope.dnsCredentials.cloudflareEmail = $scope.dnsConfig.email;

        $scope.dnsCredentials.provider = $scope.dnsConfig.provider === 'caas' ? 'route53' : $scope.dnsConfig.provider;
        $scope.dnsCredentials.provider = ($scope.dnsCredentials.provider === 'manual' && $scope.dnsConfig.wildcard) ? 'wildcard' : $scope.dnsCredentials.provider;

        $('#dnsCredentialsModal').modal('show');
    };

    Client.onReady(function () {
        Client.getDnsConfig(function (error, result) {
            if (error) return console.error(error);

            $scope.dnsConfig = result;
        });
    });

    // setup all the dialog focus handling
    ['dnsCredentialsModal'].forEach(function (id) {
        $('#' + id).on('shown.bs.modal', function () {
            $(this).find("[autofocus]:first").focus();
        });
    });

    $('.modal-backdrop').remove();
}]);
