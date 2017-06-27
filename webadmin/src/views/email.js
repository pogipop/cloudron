'use strict';

angular.module('Application').controller('EmailController', ['$scope', '$location', '$rootScope', 'Client', 'AppStore', function ($scope, $location, $rootScope, Client, AppStore) {
    Client.onReady(function () { if (!Client.getUserInfo().admin) $location.path('/'); });

    $scope.client = Client;
    $scope.user = Client.getUserInfo();
    $scope.config = Client.getConfig();
    $scope.dnsConfig = {};
    $scope.outboundPort25 = {};
    $scope.expectedDnsRecords = {};
    $scope.expectedDnsRecordsTypes = [
        { name: 'MX', value: 'mx' },
        { name: 'DKIM', value: 'dkim' },
        { name: 'SPF', value: 'spf' },
        { name: 'DMARC', value: 'dmarc' },
        { name: 'PTR', value: 'ptr' }
    ];
    $scope.mailConfig = null;
    $scope.users = [];
    $scope.isPaying = false;

    $scope.showView = function (view) {
        // wait for dialog to be fully closed to avoid modal behavior breakage when moving to a different view already
        $('.modal').on('hidden.bs.modal', function () {
            $('.modal').off('hidden.bs.modal');
            $location.path(view);
        });

        $('.modal').modal('hide');
    };

    $scope.catchall = {
        addresses: [],
        busy: false,

        submit: function () {
            $scope.catchall.busy = true;

            Client.setCatchallAddresses($scope.catchall.addresses, function (error) {
                if (error) console.error('Unable to add catchall address.', error);

                $scope.catchall.busy = false;
            });
        }
    };

    $scope.email = {
        refreshBusy: false,

        toggle: function () {
            if ($scope.mailConfig.enabled) return $scope.email.disable();

            // show warning first
            $('#enableEmailModal').modal('show');
        },

        enable: function () {
            $('#enableEmailModal').modal('hide');

            Client.setMailConfig({ enabled: true }, function (error) {
                if (error) return console.error(error);

                $scope.mailConfig.enabled = true;
            });
        },

        disable: function () {
            Client.setMailConfig({ enabled: false }, function (error) {
                if (error) return console.error(error);

                $scope.mailConfig.enabled = false;
            });
        },

        refresh: function () {
            $scope.email.refreshBusy = true;

            showExpectedDnsRecords(function (error) {
                if (error) console.error(error);

                $scope.email.refreshBusy = false;
            });
        }
    };

    $scope.mailRelayPresets = [
        { id: 'custom', name: 'Custom', smtpHost: '', smtpPort: 25, tls: false },
        { id: 'google', name: 'Google', smtpHost: 'smtp.gmail.com', smtpPort: 587, tls: true },
        { id: 'sendgrid', name: 'SendGrid', smtpHost: 'smtp.sendgrid.net', smtpPort: 587, tls: true },
        { id: 'ses', name: 'Amazon SES', smtpHost: 'email-smtp.us-east-1.amazonaws.com', smtpPort: 25, tls: true }
    ];

    $scope.mailRelay = {
        error: {},
        busy: false,
        preset: $scope.mailRelayPresets[0],

        presetChanged: function () {
            $scope.mailRelay.smtpHost = $scope.mailRelay.preset.smtpHost;
            $scope.mailRelay.smtpPort = $scope.mailRelay.preset.smtpPort;
            $scope.mailRelay.tls = $scope.mailRelay.preset.tls;
        },

        // form data to be set on load
        used: false,
        smtpHost: '',
        smtpPort: 25,
        username: '',
        password: '',
        tls: true,

        submit: function () {
            console.error('Not implemented');
        }
    };

    function getMailConfig() {
        Client.getMailConfig(function (error, mailConfig) {
            if (error) return console.error(error);

            $scope.mailConfig = mailConfig;
        });
    }

    function getDnsConfig() {
        Client.getDnsConfig(function (error, dnsConfig) {
            if (error) return console.error(error);

            $scope.dnsConfig = dnsConfig;
        });
    }

    function showExpectedDnsRecords(callback) {
        callback = callback || function (error) { if (error) console.error(error); };

        Client.getEmailStatus(function (error, result) {
            if (error) return callback(error);

            $scope.expectedDnsRecords = result.dns;
            $scope.outboundPort25 = result.outboundPort25;

            // open the record details if they are not correct
            for (var type in $scope.expectedDnsRecords) {
                if (!$scope.expectedDnsRecords[type].status) {
                    $('#collapse_dns_' + type).collapse('show');
                }
            }

            if (!$scope.outboundPort25.status) {
                $('#collapse_dns_port').collapse('show');
            }

            callback(null);
        });
    }

    function getUsers() {
        Client.getUsers(function (error, result) {
            if (error) return console.error('Unable to get user listing.', error);

            // only allow users with a Cloudron email address
            $scope.catchall.availableAddresses = result.filter(function (u) { return !!u.email; }).map(function (u) { return u.username; });
        });
    }

    function getCatchallAddresses() {
        Client.getCatchallAddresses(function (error, result) {
            if (error) return console.error('Unable to get catchall address listing.', error);

            // dedupe in case to avoid angular breakage
            $scope.catchall.addresses = result.filter(function(item, pos, self) {
                return self.indexOf(item) == pos;
            });
        });
    }

    function getSubscription() {
        if ($scope.config.provider === 'caas') {
            $scope.isPaying = true;
            return;
        }

        Client.getAppstoreConfig(function (error, result) {
            if (error) return console.error(error);

            if (!result.token) return;

            AppStore.getSubscription(result, function (error, result) {
                if (error) return console.error(error);

                $scope.isPaying = result.plan.id !== 'free' && result.plan.id !== 'undecided';
            });
        });
    }

    Client.onReady(function () {
        getMailConfig();
        getDnsConfig();
        getSubscription();
        getUsers();
        getCatchallAddresses();
        $scope.email.refresh();
    });

    $('.modal-backdrop').remove();
}]);
