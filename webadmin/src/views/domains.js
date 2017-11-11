'use strict';

angular.module('Application').controller('DomainsController', ['$scope', '$location', 'Client', 'ngTld', function ($scope, $location, Client, ngTld) {
    Client.onReady(function () { if (!Client.getUserInfo().admin) $location.path('/'); });

    $scope.config = Client.getConfig();
    $scope.dnsConfig = null;
    $scope.domains = [];
    $scope.ready = false;

    // keep in sync with setupdns.js
    $scope.dnsProvider = [
        { name: 'AWS Route53', value: 'route53' },
        { name: 'Cloudflare (DNS only)', value: 'cloudflare' },
        { name: 'Digital Ocean', value: 'digitalocean' },
        { name: 'Google Cloud DNS', value: 'gcdns' },
        { name: 'Wildcard', value: 'wildcard' },
        { name: 'Manual (not recommended)', value: 'manual' },
        { name: 'No-op (only for development)', value: 'noop' }
    ];

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

    // We reused configure also for adding domains to avoid much code duplication
    $scope.domainConfigure = {
        adding: false,
        error: null,
        busy: false,
        domain: null,

        // form model
        newDomain: '',
        accessKeyId: '',
        secretAccessKey: '',
        gcdnsKey: { keyFileName: '', content: '' },
        digitalOceanToken: '',
        cloudflareToken: '',
        cloudflareEmail: '',
        provider: 'route53',

        show: function (domain) {
            $scope.domainConfigure.reset();

            if (domain) {
                $scope.domainConfigure.domain = domain;
                $scope.domainConfigure.accessKeyId = domain.config.accessKeyId;
                $scope.domainConfigure.secretAccessKey = domain.config.secretAccessKey;

                $scope.domainConfigure.gcdnsKey.keyFileName = '';
                $scope.domainConfigure.gcdnsKey.content = '';
                if ($scope.domainConfigure.provider === 'gcdns') {
                    $scope.domainConfigure.gcdnsKey.keyFileName = domain.config.credentials.client_email;
                    $scope.domainConfigure.gcdnsKey.content = JSON.stringify({
                        "project_id": domain.config.projectId,
                        "credentials": domain.config.credentials
                    });
                }
                $scope.domainConfigure.digitalOceanToken = domain.config.provider === 'digitalocean' ? domain.config.token : '';
                $scope.domainConfigure.cloudflareToken = domain.config.provider === 'cloudflare' ? domain.config.token : '';
                $scope.domainConfigure.cloudflareEmail = domain.config.email;

                $scope.domainConfigure.provider = domain.config.provider === 'caas' ? 'route53' : domain.config.provider;
                $scope.domainConfigure.provider = ($scope.domainConfigure.provider === 'manual' && domain.config.wildcard) ? 'wildcard' : domain.config.provider;
            } else {
                $scope.domainConfigure.adding = true;
            }

            $('#domainConfigureModal').modal('show');
        },

        submit: function () {
            $scope.domainConfigure.busy = true;
            $scope.domainConfigure.error = null;

            var data = {
                provider: $scope.domainConfigure.provider
            };

            // special case the wildcard provider
            if (data.provider === 'wildcard') {
                data.provider = 'manual';
                data.wildcard = true;
            }

            if (data.provider === 'route53') {
                data.accessKeyId = $scope.domainConfigure.accessKeyId;
                data.secretAccessKey = $scope.domainConfigure.secretAccessKey;
            } else if (data.provider === 'gcdns'){
                try {
                    var serviceAccountKey = JSON.parse($scope.domainConfigure.gcdnsKey.content);
                    data.projectId = serviceAccountKey.project_id;
                    data.credentials = {
                        client_email: serviceAccountKey.client_email,
                        private_key: serviceAccountKey.private_key
                    };

                    if (!data.projectId || !data.credentials || !data.credentials.client_email || !data.credentials.private_key) {
                        throw 'fields_missing';
                    }
                } catch (e) {
                    $scope.domainConfigure.error = 'Cannot parse Google Service Account Key: ' + e.message;
                    $scope.domainConfigure.busy = false;
                    return;
                }
            } else if (data.provider === 'digitalocean') {
                data.token = $scope.domainConfigure.digitalOceanToken;
            } else if (data.provider === 'cloudflare') {
                data.token = $scope.domainConfigure.cloudflareToken;
                data.email = $scope.domainConfigure.cloudflareEmail;
            }

            // choose the right api, since we reuse this for adding and configuring domains
            var func;
            if ($scope.domainConfigure.adding) func = Client.addDomain.bind(Client, $scope.domainConfigure.newDomain, data);
            else func = Client.updateDomain.bind(Client, $scope.domainConfigure.domain.domain, data) ;

            func(function (error) {
                $scope.domainConfigure.busy = false;
                if (error) {
                    $scope.domainConfigure.error = error.message;
                    return;
                }

                $('#domainConfigureModal').modal('hide');
                $scope.domainConfigure.reset();

                // reload the domains
                Client.getDomains(function (error, result) {
                    if (error) return console.error(error);

                    $scope.domains = result;
                });
            });
        },

        reset: function () {
            $scope.domainConfigure.adding = false;
            $scope.domainConfigure.newDomain = '';

            $scope.domainConfigure.busy = false;
            $scope.domainConfigure.error = null;

            $scope.domainConfigure.provider = '';
            $scope.domainConfigure.accessKeyId = '';
            $scope.domainConfigure.secretAccessKey = '';
            $scope.domainConfigure.gcdnsKey.keyFileName = '';
            $scope.domainConfigure.gcdnsKey.content = '';
            $scope.domainConfigure.digitalOceanToken = '';
            $scope.domainConfigure.cloudflareToken = '';
            $scope.domainConfigure.cloudflareEmail = '';

            $scope.domainConfigureForm.$setPristine();
            $scope.domainConfigureForm.$setUntouched();
        }
    };

    $scope.domainRemove = {
        busy: false,
        error: null,
        domain: null,
        password: '',

        show: function (domain) {
            $scope.domainRemove.reset();

            $scope.domainRemove.domain = domain;

            $('#domainRemoveModal').modal('show');
        },

        submit: function () {
            $scope.domainRemove.busy = true;
            $scope.domainRemove.error = null;

            Client.removeDomain($scope.domainRemove.domain.domain, $scope.domainRemove.password, function (error) {
                if (error && (error.statusCode === 403 || error.statusCode === 409)) {
                    $scope.domainRemove.password = '';
                    $scope.domainRemove.error = error.message;
                    $scope.domainRemoveForm.password.$setPristine();
                    $('#domainRemovePasswordInput').focus();
                } else if (error) {
                    Client.error(error);
                } else {
                    $('#domainRemoveModal').modal('hide');
                    $scope.domainRemove.reset();

                    // reload the domains
                    Client.getDomains(function (error, result) {
                        if (error) return console.error(error);

                        $scope.domains = result;
                    });
                }

                $scope.domainRemove.busy = false;
            });
        },

        reset: function () {
            $scope.domainRemove.busy = false;
            $scope.domainRemove.error = null;
            $scope.domainRemove.domain = null;
            $scope.domainRemove.password = '';

            $scope.domainRemoveForm.$setPristine();
            $scope.domainRemoveForm.$setUntouched();
        }
    };

    Client.onReady(function () {
        Client.getDomains(function (error, result) {
            if (error) return console.error(error);

            $scope.domains = result;
            $scope.ready = true;
        });
    });

    document.getElementById('gcdnsKeyFileInput').onchange = readFileLocally($scope.domainConfigure.gcdnsKey, 'content', 'keyFileName');

    // setup all the dialog focus handling
    ['domainConfigureModal', 'domainRemoveModal'].forEach(function (id) {
        $('#' + id).on('shown.bs.modal', function () {
            $(this).find("[autofocus]:first").focus();
        });
    });

    $('.modal-backdrop').remove();
}]);
